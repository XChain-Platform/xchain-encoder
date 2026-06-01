/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Encoder - Encoder Class
 * 
 * This file handles starting the encoder and generating transactions
 * 
 ********************************************************************/

// Load required libraries
const bitcoin = require('bitcoinjs-lib');
const crypto = require('crypto');
const bs58check = require('bs58check')
const BlockchainConnector = require('./BlockchainConnector')
const CryptoNetworks = require('./CryptoNetworks')
const UtxoTracker = require('./UtxoTracker')
const TxSizeEstimator = require("./TxSizeEstimator")
const { MAX_COMPILED_ACTION_DATA_LENGTH } = require('./validator')

const OP_RETURN_SIZE = 80
const P2SH_SIZE = 520
const PW2SH_SIZE = 3615 // bitcoinjs-lib enforces a 3600-byte redeem script limit; 3615 - 44 overhead = 3571 max chunk
const MULTISIGN_SIZE = 69 // dataToPubkey handles at most 32 bytes per slice; chunk = magic(4) + data(N), split at byte 32 → max chunk = 64 → max data = 60 → 60 + 4(magic) + 5(overhead) = 69
const MAGIC_WORD = "XCHN"

const SATOSHI_UNIT = 100000000

const Encoding = {
    OP_RETURN: "OP_RETURN",
    P2SH: "P2SH",
    MULTISIGN: "MULTISIGN",
    P2WSH: "P2WSH"
}


class XChainEncoder {
    constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, utxoTrackerUrl, utxoTrackerPort, maxFeeRateKb=null) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
      this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
      this.utxoTrackerConnector = new UtxoTracker(utxoTrackerUrl, utxoTrackerPort)
      this.dustAmount = this.network["dustThreshold"]
      // Maximum fee rate in BTC/byte (null = no cap). Prevents runaway estimates
      // (e.g. regtest feedback loop) from producing fees that the node will reject.
      // MAX_FEE_RATE_KB is in sat/kB, convert to BTC/byte to match feePerBytes units.
      this.maxFeePerBytes = maxFeeRateKb ? maxFeeRateKb / 1000 / SATOSHI_UNIT : null
    }
    
    isSegwitUTXO(utxo) {
        try {
            const script = bitcoin.script.decompile(Buffer.from(utxo.scriptPubKey, 'hex'));
            
            return script[0] === 0x00; // Verificar si es un script de versión 0
        } catch (error) {
            // If there is an error trying to get the script, let's assume is not segwit
            return false;
        }
    }
    
    prepareData(data, encoding, pubKey){
        let magicWordBuffer = Buffer.from(MAGIC_WORD,'utf8')
        
        if (!encoding){
            if (data.length + magicWordBuffer.length <= OP_RETURN_SIZE) {
                encoding = Encoding.OP_RETURN
            } else {
                encoding = Encoding.P2SH
            }
        }       
        let chunksSize = 0
        let dataBufferArray = []
        let i = 0
        let nextDataChunk = null
        switch (encoding){
            case Encoding.OP_RETURN:
                chunksSize = OP_RETURN_SIZE - magicWordBuffer.length //There will be many OP_RETURNS with the data inside, and this data will have the magic word appended on the beginning
                
                i = 0
                while (i < data.length){
                    nextDataChunk = data.subarray(i,i+chunksSize)
                    dataBufferArray.push(Buffer.concat([magicWordBuffer,nextDataChunk]))
                    i = i + nextDataChunk.length
                }
                
                return {"dataBufferArray":dataBufferArray, "encoding": encoding}
            case Encoding.P2SH:
            case Encoding.P2WSH:
                /* REDEEM SCRIPT
                data_chunk (max 480 bytes)
                +
                OP_DROP //1 byte
                +
                OP_DUP //1 byte
                +
                OP_HASH160 //1 byte
                +
                publicKey //33 bytes compressed
                +
                OP_EQUALVERIFY //1 byte
                +
                OP_CHECKSIG //1 byte
                +
                n //1 byte
                +
                OP_DEPTH // 1byte
                +
                0 // 1 byte
                +
                OP_EQUAL // 1 byte
                */
                
                chunksSize = (encoding == Encoding.P2SH?P2SH_SIZE:PW2SH_SIZE) - 44 //There will be many P2SH outputs, later the inputs spending this outputs will have the data inside the script
                
                let pubkeyFromBase58 = bitcoin.address.fromBase58Check(pubKey).hash
                
                i = 0
                while (i < data.length){
                    nextDataChunk = data.subarray(i,i+chunksSize)
                    
                    let nextDataBuffer = bitcoin.script.compile([
                        nextDataChunk, 
                        bitcoin.opcodes.OP_DROP,
                        bitcoin.opcodes.OP_DUP,
                        bitcoin.opcodes.OP_HASH160,
                        pubkeyFromBase58,
                        bitcoin.opcodes.OP_EQUALVERIFY,
                        bitcoin.opcodes.OP_CHECKSIG,
                        
                        /*
                        //Add this to prevent malleability
                        i,
                        bitcoin.opcodes.OP_DEPTH,
                        0,
                        bitcoin.opcodes.OP_EQUAL,*/
                    ])
                    
                    dataBufferArray.push(nextDataBuffer)
                    i = i + nextDataChunk.length
                }
                
                return {"dataBufferArray":dataBufferArray, "encoding": encoding}
            case Encoding.MULTISIGN:
                chunksSize = MULTISIGN_SIZE 
                    - magicWordBuffer.length 
                    - 1 //1 byte for the OP_CHECKMULTISIG
                    - 1 //1 byte for the m signatures to pop
                    - 1 //1 byte for the n addresses to pop
                    - 1 //1 byte for the first address length
                    - 1 //1 byte for the second address length
                
                // Each MULTISIGN output carries its data across two 32-byte
                // pubkey halves (64 data bytes total). A full chunk is already
                // magic(4) + 60 = 64 bytes, but the final chunk is shorter.
                // Zero-pad every chunk up to the full 64-byte slot so BOTH
                // pubkey halves are always complete 32-byte values. Without
                // this, a short final chunk leaves the second half empty (or
                // near-empty); dataToPubkey() then produces an all-zero /
                // low-entropy EC point that bitcoinjs-lib rejects as not a
                // valid point. The reader strips this trailing pad using the
                // payload's own self-describing compiled-script length, so the
                // padding is invisible end-to-end.
                let multisignSlotSize = 64

                i = 0
                while (i < data.length){
                    nextDataChunk = data.subarray(i,i+chunksSize)
                    let nextChunk = Buffer.concat([magicWordBuffer,nextDataChunk])
                    if (nextChunk.length < multisignSlotSize){
                        nextChunk = Buffer.concat([nextChunk, Buffer.alloc(multisignSlotSize - nextChunk.length, 0)])
                    }
                    dataBufferArray.push(nextChunk)
                    i = i + nextDataChunk.length
                }

                return {"dataBufferArray":dataBufferArray, "encoding": encoding}
            default:
                throw new TypeError(`Unknown encoding: "${encoding}". Valid values: OP_RETURN, P2SH, MULTISIGN, P2WSH`)
        }
    }
    
    async obfuscate(data, key){
        var cipherKey = key.substr(0,16)
        var iv = key.substr(16,16)
        
        var cipher = crypto.createCipheriv('aes-128-ctr', cipherKey, iv);
        var encryptedData = cipher.update(data)
        encryptedData = Buffer.concat([encryptedData,cipher.final()])
        return encryptedData
    }
    
    //This function transforms a raw data into something similar to a pubkey
    async dataToPubkey(data){
        let bufferArray = [Buffer.from("02","hex"),data]
        let bufferFill = null
        if (data.length < 32){
            bufferFill = Buffer.allocUnsafe(32 - data.length)
            bufferFill.fill("00", 0, bufferFill.length, "hex")
            bufferArray.push(bufferFill)
        }
        
        return Buffer.concat(bufferArray)
    }
    
    //This function will create a transaction for the xchain platform
    async createTransaction(utxos, pubkey, customOutputs, data, rawData, fee, replacebyfee,
      encoding, change, p2shHash=null, p2shHex=null, compressedPubKey=null,
      unconfirmed=true, feePerKb=null, dust=null, feeQuote=null){

        // If feeQuote is provided, inject it as a custom output
        if(feeQuote && feeQuote.address && feeQuote.amount > 0){
            if(!customOutputs) customOutputs = [];
            customOutputs.push({ address: feeQuote.address, value: feeQuote.amount });
        }

        let feePerBytes = null
        if (feePerKb){
            feePerBytes = feePerKb/1000
        } else {
            feePerBytes = await this.connector.getFeePerKilobyte(1)/1000 //Highest fee. In bitcoin context every kilobyte is 1000 bytes
        }
        if (this.maxFeePerBytes && feePerBytes > this.maxFeePerBytes) {
            feePerBytes = this.maxFeePerBytes
        }
        
        let finalDust = this.dustAmount
        if (dust){
            finalDust = dust
        }
        
        let dataBuffer = Buffer.from(data, 'utf8')
        let dataToCompile = [dataBuffer]
        
        if (rawData != null){
            // 'binary' (Latin-1) preserves bytes 0-255 one-to-one. 'utf8' would
            // corrupt arbitrary binary payloads (e.g. AES-GCM ciphertext for
            // token-gated FILEs). Existing ASCII callers like base64-encoded
            // file bytes are byte-identical under both encodings.
            let rawDataBuffer = Buffer.from(rawData, 'binary')
            dataToCompile.push(rawDataBuffer)
        }
        
        let finalDataBuffer = bitcoin.script.compile(dataToCompile)

        // Enforce the same compiled-push ceiling the indexing decoder applies
        // (MAX_ACTION_DATA_LENGTH). The decoder measures the compiled on-chain
        // push and drops anything larger, so a transaction above this size
        // would be silently dropped by every node — reject it at encode time.
        if (finalDataBuffer.length > MAX_COMPILED_ACTION_DATA_LENGTH) {
            throw new RangeError(`Payload too large: compiled size ${finalDataBuffer.length} bytes exceeds maximum ${MAX_COMPILED_ACTION_DATA_LENGTH} bytes (compiled on-chain ACTION push)`)
        }

        if (encoding === 'P2WSH' && this.network.supportsSegwit === false) {
            throw new TypeError('P2WSH encoding is not supported on this network (no segwit support)')
        }

        let psbt = null
        
        let utxoSequence = (replacebyfee? 0x00000001: 0xffffffff)
        //let txidFirstInput = null
        let inputSatoshis = 0

        if ((utxos == null) || (utxos.length == 0)){
            utxos = await this.utxoTrackerConnector.getUtxosFromAddress(pubkey)
            utxos = utxos["utxos"]
            
            if ((utxos == null) || (utxos.length == 0)){
                throw new Error("no utxos were provided and no utxos found on the blockchain")
            }
        }
        
        //Remove duplicated utxos (the utxo tracker returns duplicated utxos sometimes, this should be fixed)
        //Also if unconfirmed is false, then all mempool txs will be eliminated
        let utxoIndex = 0
        while (utxoIndex < utxos.length){
            let nextUtxo = utxos[utxoIndex]
            
            //if the tx is in the mempool, remove it if unconfirmed is false
            if (!unconfirmed && (nextUtxo.confirmations == 0)){
                utxos.splice(utxoIndex, 1)
            } else {
            
                let utxoDupIndex = utxoIndex + 1
                while (utxoDupIndex < utxos.length){
                    let nextUtxoDup = utxos[utxoDupIndex]
                    
                    if ((nextUtxoDup.txid == nextUtxo.txid) && (nextUtxoDup.vout == nextUtxo.vout)){
                        utxos.splice(utxoDupIndex, 1)
                    } else {
                        utxoDupIndex = utxoDupIndex + 1
                    }
                }
                
                utxoIndex = utxoIndex+1
            }
        }

        //If unconfirmed=false stripped every mempool UTXO and nothing
        //confirmed remains, surface the same error as a never-funded
        //address rather than crashing on utxos[0] below.
        if (utxos.length == 0){
            throw new Error("no utxos were provided and no utxos found on the blockchain")
        }

        //Order the utxos from the biggest value to the smallest
        utxos.sort((a,b)=> b.value - a.value)
        let txidFirstInput = utxos[0]["txid"] //The first utxo will always be used as the first input
        
        if (!p2shHash){//We need to prepare the data to know which inputs the p2sh will have
            psbt = new bitcoin.Psbt({ network: this.network })
        }
        
        //Prepare the Data
        let preparedData = this.prepareData(finalDataBuffer, encoding, pubkey)
        
        let outputSatoshis = 0
        let voutPsbtIndex = 0
        let obfuscatedData
        
        let estimatedTxSize = 0
        
        for (let nextDataBufferIndex in preparedData["dataBufferArray"]){
            let nextDataBuffer = preparedData["dataBufferArray"][nextDataBufferIndex]
            
            switch (preparedData["encoding"]){
                case Encoding.OP_RETURN:
                
                    obfuscatedData = await this.obfuscate(nextDataBuffer, txidFirstInput)
                    let opReturnScript = bitcoin.payments.embed({ data: [obfuscatedData] })
                    
                    psbt.addOutput({
                        script: opReturnScript.output,
                        value: 0
                    })
                    
                    //TODO: this won't work if data is greater than 
                    estimatedTxSize = estimatedTxSize 
                        + TxSizeEstimator.estimateOpReturnOutput(obfuscatedData)
                    
                    break
                case Encoding.P2SH:
                    if (p2shHex){
                        let p2shTx = bitcoin.Transaction.fromHex(p2shHex)
                        txidFirstInput = p2shTx.getId()
                    }
                    
                    if (p2shHash){
                        if (!psbt){
                            let opReturnData = await this.obfuscate(
                                Buffer.concat([
                                    Buffer.from(MAGIC_WORD,'utf8'),
                                    Buffer.from("p2sh",'utf8')
                                ]),
                                txidFirstInput
                            )
                        
                            psbt = new bitcoin.Psbt({ network: this.network })
                            psbt.addOutput({
                                script: bitcoin.payments.embed({
                                    data: [opReturnData]
                                }).output,
                                value: 0
                            })
                            
                            estimatedTxSize = estimatedTxSize
                                + TxSizeEstimator.estimateOpReturnOutput(opReturnData)
                        }
                        
                        let nextInput = {
                            sequence: utxoSequence,
                            hash:p2shHash,
                            redeemScript:nextDataBuffer,
                            index: voutPsbtIndex,
                            nonWitnessUtxo:Buffer.from(p2shHex, 'hex')
                        }
                        
                        psbt.addInput(nextInput)
                        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
                        
                        voutPsbtIndex = voutPsbtIndex + 1                   
                    } else {
                        let spendingP2shEstimatedSize = this.estimateSpendingP2shTx(nextDataBuffer)
                        let spendingP2shEstimatedFee = Math.trunc((spendingP2shEstimatedSize * feePerBytes) * SATOSHI_UNIT)
                    
                        if (spendingP2shEstimatedFee < finalDust){
                            spendingP2shEstimatedFee = finalDust
                        }
                    
                        psbt.addOutput({
                            address: bitcoin.payments.p2sh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
                            value:spendingP2shEstimatedFee
                        })
                        
                        outputSatoshis = outputSatoshis + spendingP2shEstimatedFee
                        
                        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateP2shOutput()
                    }
                    
                    break
                case Encoding.P2WSH:
                    let p2shTx = null
                    if (p2shHex){
                        p2shTx = bitcoin.Transaction.fromHex(p2shHex)
                        txidFirstInput = p2shTx.getId()
                    }
                    
                    if (p2shHash){
                        if (!psbt){
                            psbt = new bitcoin.Psbt({ network: this.network })
                            psbt.addOutput({
                                script: bitcoin.payments.embed({
                                    data: [
                                        await this.obfuscate(
                                            Buffer.concat([
                                                Buffer.from(MAGIC_WORD,'utf8'),
                                                Buffer.from("p2wsh",'utf8')
                                            ]),
                                            txidFirstInput
                                        )
                                    ]
                                }).output,
                                value: 0
                            })
                        }
                        
                        if (!p2shTx || !p2shTx.outs || voutPsbtIndex >= p2shTx.outs.length) {
                            throw new RangeError(`p2shHex transaction does not have output at index ${voutPsbtIndex}`)
                        }
                        let nextInput = {
                            sequence: utxoSequence,
                            hash:p2shHash,
                            //redeem:{output:nextDataBuffer},
                            witnessScript:nextDataBuffer,
                            index: voutPsbtIndex,
                            witnessUtxo:{
                                script:p2shTx["outs"][voutPsbtIndex]["script"],
                                value:p2shTx["outs"][voutPsbtIndex]["value"]
                            }
                        }
                        psbt.addInput(nextInput)
                        
                        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
                        voutPsbtIndex = voutPsbtIndex + 1                   
                    } else {
                        psbt.addOutput({
                            address: bitcoin.payments.p2wsh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
                            value:finalDust
                        })
                        
                        estimatedTxSize = estimatedTxSize
                            + TxSizeEstimator.estimateP2wshOutput()
                    }
                    
                    break
                case Encoding.MULTISIGN:
                    obfuscatedData = await this.obfuscate(nextDataBuffer, txidFirstInput)
                    let pubkey1 = await this.dataToPubkey(obfuscatedData.slice(0, 32))
                    let pubkey2 = await this.dataToPubkey(obfuscatedData.slice(32, obfuscatedData.length))
                    let pubkey3 = Buffer.from(compressedPubKey,"hex")
                    
                    let pubkeys = [
                        pubkey1,
                        pubkey2,
                        pubkey3
                    ]
                    
                    let multisignScript = bitcoin.payments.p2ms(
                        { 
                            m:1, //We only need one signature
                            pubkeys: pubkeys,
                            network: this.network
                        }
                    )
                    
                    // A bare multisig output is larger than a P2PKH, so the flat
                    // P2PKH dust floor (this.dustAmount = 546) is below the node's
                    // relay dust threshold and the broadcast is rejected with
                    // {"code":-26,"message":"dust"}. Size the floor from the actual
                    // output script using Bitcoin Core's dust formula:
                    // (output_bytes + spend_input_bytes) * 3 sat/byte. The spend cost
                    // assumes a 148-byte P2PKH-style input. For standard 1-of-3
                    // compressed-key scripts (105 bytes) this is ~786 sat.
                    let bareMultisigDust = Math.ceil((8 + 1 + multisignScript.output.length + 148) * 3)
                    let multisigOutputValue = Math.max(finalDust, bareMultisigDust)

                    psbt.addOutput({
                        script: multisignScript.output,
                        value: multisigOutputValue
                        })
                    // Account for the data output's value so change is not over-credited
                    // (otherwise total outputs exceed total inputs and the tx is invalid).
                    outputSatoshis += multisigOutputValue

                    estimatedTxSize = estimatedTxSize
                        + TxSizeEstimator.estimateMultisignOutput(obfuscatedData)
                        
                    break   
            }
        }

        // Process custom outputs (e.g., COINPay native coin payment outputs)
        if (customOutputs && Array.isArray(customOutputs)) {
            for (let i = 0; i < customOutputs.length; i++) {
                const output = customOutputs[i]
                const outputValue = parseInt(output.value, 10)
                if (isNaN(outputValue) || outputValue < 0) {
                    throw new RangeError(`customOutputs[${i}].value is not a valid satoshi amount`)
                }
                psbt.addOutput({
                    address: output.address,
                    value:   outputValue
                })
                outputSatoshis += outputValue
                estimatedTxSize += 43 // Taproot output size estimate (most expensive)
            }
        }

        //the output for the change address. The most expensive type of address: taproot
        estimatedTxSize = estimatedTxSize + 43

        let estimatedFee = 0
        if (fee != null && fee !== false) {
            const numFee = parseInt(fee, 10)
            if (isNaN(numFee) || numFee < 0) {
                throw new RangeError(`fee must be a non-negative integer, got: ${fee}`)
            }
            estimatedFee = numFee
        }
        
        if (!p2shHash){//The p2sh input is already created before
            let nextUtxoIndex = 0
            while (nextUtxoIndex < utxos.length){
                let nextUtxo = utxos[nextUtxoIndex]
                nextUtxo.value = parseInt(nextUtxo.value, 10)
                if (isNaN(nextUtxo.value) || nextUtxo.value < 0) {
                    throw new RangeError(`utxos[${nextUtxoIndex}].value is not a valid satoshi amount`)
                }
                
                //if (!txidFirstInput){
                //    txidFirstInput = nextUtxo["txid"]
                //}
                
                if (this.isSegwitUTXO(nextUtxo)){
                    let nextInput = {
                        hash: nextUtxo.txid,
                        index: nextUtxo.vout,
                        sequence: utxoSequence,
                        witnessUtxo: {
                            script: Buffer.from(nextUtxo.scriptPubKey, 'hex'),
                            value: nextUtxo.value,
                        }
                    }
                    psbt.addInput(nextInput)
                    
                    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
                    inputSatoshis = inputSatoshis + nextUtxo.value
                } else {
                    let wholeUtxoHex = await this.connector.getTransactionHex(nextUtxo.txid)
                    let nextInput = {
                        hash: nextUtxo.txid,
                        index: nextUtxo.vout,
                        sequence: utxoSequence,
                        nonWitnessUtxo: Buffer.from(wholeUtxoHex, 'hex')
                    }
                    psbt.addInput(nextInput)
                    
                    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)                    
                    inputSatoshis = inputSatoshis + nextUtxo.value
                }
                
                if (fee == null || fee === false) {
                    estimatedFee = Math.trunc(estimatedTxSize * feePerBytes * SATOSHI_UNIT)
                }
                
                if (inputSatoshis > outputSatoshis + estimatedFee){
                    break
                }
                
                nextUtxoIndex = nextUtxoIndex + 1
            }
        }
        
        //The fee can't be less than the network dust limit
        if (estimatedFee < this.dustAmount){
            estimatedFee = this.dustAmount
        }
        
        let changeSatoshis = inputSatoshis - outputSatoshis - estimatedFee

        if (!Number.isFinite(changeSatoshis)) {
            throw new RangeError('Fee calculation produced invalid result. Check that all UTXO values and fees are valid integers.')
        }

        if ((changeSatoshis > this.dustAmount) && !change) {
            throw new Error('Transaction would burn significant satoshis as fees. Please provide a change address.')
        }

        if ((changeSatoshis > 0) && (change)) {
            psbt.addOutput({
                address: change,
                value: changeSatoshis
            })
        }
        
        return {"psbt":psbt,"encoding":preparedData["encoding"]}
    }
    
    estimateSpendingP2shTx(redeemData){
        // Per-chunk embedded value sized to cover the spending tx's worst
        // case at 1 sat/vbyte. Includes tx overhead, the OP_RETURN marker
        // output, the P2SH input bringing this chunk's redeem script (sig +
        // compressed pubkey + redeem script push — see estimateP2shInputWithRedeem),
        // plus a small safety margin to absorb DER signature length jitter so the
        // broadcast never lands fractionally under the node's min relay fee floor.
        let sizeEstimated =
            10 // 4 version + 1 inputs count + 1 outputs count + 4 locktime
            + TxSizeEstimator.estimateP2shInputWithRedeem(redeemData)
            + TxSizeEstimator.estimateOpReturnOutput(Buffer.concat([
                Buffer.from(MAGIC_WORD,'utf8'),
                Buffer.from("p2sh",'utf8')
            ]))
            + 8 // safety margin for DER-sig length jitter (sig push assumes 72B)

        return sizeEstimated
    }
}

module.exports = XChainEncoder