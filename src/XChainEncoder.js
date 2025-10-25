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

const OP_RETURN_SIZE = 80
const P2SH_SIZE = 520
const PW2SH_SIZE = 10000
const MULTISIGN_SIZE = 71
const MAGIC_WORD = "XCHN"

const SATOSHI_UNIT = 100000000

const OutputType = {
    OP_RETURN: "OP_RETURN",
    P2SH: "P2SH",
    MULTISIGN: "MULTISIGN",
    P2WSH: "P2WSH"
}


class XChainEncoder {
    constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, utxoTrackerUrl, utxoTrackerPort, dustAmount) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
      this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
      this.utxoTrackerConnector = new UtxoTracker(utxoTrackerUrl, utxoTrackerPort)
      this.dustAmount = dustAmount
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
    
    prepareData(data, outputType, pubKey){
        let magicWordBuffer = Buffer.from(MAGIC_WORD,'utf8')
        
        if (!outputType){
            if (data.length + magicWordBuffer.length <= OP_RETURN_SIZE) {
                outputType = OutputType.OP_RETURN
            } else {
                outputType = OutputType.P2SH
            }
        }       
        let chunksSize = 0
        let dataBufferArray = []
        let i = 0
        let nextDataChunk = null
        switch (outputType){
            case OutputType.OP_RETURN:
                chunksSize = OP_RETURN_SIZE - magicWordBuffer.length //There will be many OP_RETURNS with the data inside, and this data will have the magic word appended on the beginning
                
                i = 0
                while (i < data.length){
                    nextDataChunk = data.subarray(i,i+chunksSize)
                    dataBufferArray.push(Buffer.concat([magicWordBuffer,nextDataChunk]))
                    i = i + nextDataChunk.length
                }
                
                return {"dataBufferArray":dataBufferArray, "outputType": outputType}
            case OutputType.P2SH:
            case OutputType.P2WSH:
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
                
                chunksSize = (outputType == OutputType.P2SH?P2SH_SIZE:PW2SH_SIZE) - 44 //There will be many P2SH outputs, later the inputs spending this outputs will have the data inside the script
                
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
                
                return {"dataBufferArray":dataBufferArray, "outputType": outputType}
            case OutputType.MULTISIGN:
                chunksSize = MULTISIGN_SIZE 
                    - magicWordBuffer.length 
                    - 1 //1 byte for the OP_CHECKMULTISIG
                    - 1 //1 byte for the m signatures to pop
                    - 1 //1 byte for the n addresses to pop
                    - 1 //1 byte for the first address length
                    - 1 //1 byte for the second address length
                
                i = 0
                while (i < data.length){
                    nextDataChunk = data.subarray(i,i+chunksSize)
                    dataBufferArray.push(Buffer.concat([magicWordBuffer,nextDataChunk]))
                    i = i + nextDataChunk.length
                }
                
                return {"dataBufferArray":dataBufferArray, "outputType": outputType}    
        }
        
        return null
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
    async createTransaction(utxosList, pubkey, customOutputs, data, rawData, exactFee, replacebyfee, outputType, changeAddress, p2shHash=null, p2shHex=null, compressedPubKey=null){
        let feePerBytes = await this.connector.getFeePerKilobyte(1)/1000 //Highest fee. In bitcoin context every kilobyte is 1000 bytes
        let dataBuffer = Buffer.from(data, 'utf8')
        let dataToCompile = [dataBuffer]
        
        if (rawData != null){
            let rawDataBuffer = Buffer.from(rawData, 'utf8')
            dataToCompile.push(rawDataBuffer)
        }
        
        let finalDataBuffer = bitcoin.script.compile(dataToCompile)
        
        let psbt = null
        
        let utxoSequence = (replacebyfee? 0x00000001: 0xffffffff)
        //let txidFirstInput = null
        let inputSatoshis = 0

        if ((utxosList == null) || (utxosList.length == 0)){
            utxosList = await this.utxoTrackerConnector.getUtxosFromAddress(pubkey)
            utxosList = utxosList["utxos"]
            
            if ((utxosList == null) || (utxosList.length == 0)){
                throw new Error("no utxos were provided and no utxos found on the blockchain")
            }
        }
        
        //Remove duplicated utxos (the utxo tracker returns duplicated utxos sometimes, this should be fixed)
        let utxoIndex = 0
        while (utxoIndex < utxosList.length){
            let nextUtxo = utxosList[utxoIndex]
            
            let utxoDupIndex = utxoIndex + 1
            while (utxoDupIndex < utxosList.length){
                let nextUtxoDup = utxosList[utxoDupIndex]
                
                if ((nextUtxoDup.txid == nextUtxo.txid) && (nextUtxoDup.vout == nextUtxo.vout)){
                    utxosList.splice(utxoDupIndex, 1)
                } else {
                    utxoDupIndex = utxoDupIndex + 1
                }
            }
            
            utxoIndex = utxoIndex+1
        }

        //Order the utxosList from the biggest value to the smallest
        utxosList.sort((a,b)=> b.value - a.value)
        let txidFirstInput = utxosList[0]["txid"] //The first utxo will always be used as the first input
        
        if (!p2shHash){//We need to prepare the data to know which inputs the p2sh will have
            psbt = new bitcoin.Psbt({ network: this.network })
        }
        
        //Prepare the Data
        let preparedData = this.prepareData(finalDataBuffer, outputType, pubkey)
        
        let outputSatoshis = 0
        let voutPsbtIndex = 0
        let obfuscatedData
        
        let estimatedTxSize = 0
        
        for (let nextDataBufferIndex in preparedData["dataBufferArray"]){
            let nextDataBuffer = preparedData["dataBufferArray"][nextDataBufferIndex]
            
            switch (preparedData["outputType"]){
                case OutputType.OP_RETURN:
                
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
                case OutputType.P2SH:
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
                    
                        if (spendingP2shEstimatedFee < this.dustAmount){
                            spendingP2shEstimatedFee = this.dustAmount
                        }
                    
                        psbt.addOutput({
                            address: bitcoin.payments.p2sh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
                            value:spendingP2shEstimatedFee
                        })
                        
                        outputSatoshis = outputSatoshis + spendingP2shEstimatedFee
                        
                        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateP2shOutput()
                    }
                    
                    break
                case OutputType.P2WSH:
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
                            value:1000
                        })
                        
                        estimatedTxSize = estimatedTxSize
                            + TxSizeEstimator.estimateP2wshOutput()
                    }
                    
                    break
                case OutputType.MULTISIGN:
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
                    
                    psbt.addOutput({
                        script: multisignScript.output,
                        value: 1000
                        })
                        
                    estimatedTxSize = estimatedTxSize
                        + TxSizeEstimator.estimateMultisignOutput(obfuscatedData)
                        
                    break   
            }
        }
        
        //the output for the change address. The most expensive type of address: taproot
        estimatedTxSize = estimatedTxSize + 43 
        
        let estimatedFee = 0
        if (exactFee){
            estimatedFee = exactFee
        }
        
        if (!p2shHash){//The p2sh input is already created before
            let nextUtxoIndex = 0
            while (nextUtxoIndex < utxosList.length){
                let nextUtxo = utxosList[nextUtxoIndex]
                nextUtxo.value = parseInt(nextUtxo.value)
                
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
                
                if (!exactFee){
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
        
        if ((changeSatoshis > 0) && (changeAddress)) {
            psbt.addOutput({
                address: changeAddress,
                value: changeSatoshis
            })
        }
        
        return {"psbt":psbt,"encode_type":preparedData["outputType"]}
    }
    
    estimateSpendingP2shTx(redeemData){
        let sizeEstimated = 
            10 //4 version, 1 inputs count, 1 outputs count, 4 locktime
            +TxSizeEstimator.estimateP2shInputWithRedeem(redeemData) 
            +TxSizeEstimator.estimateOpReturnOutput(Buffer.concat([
                Buffer.from(MAGIC_WORD,'utf8'),
                Buffer.from("p2sh",'utf8')
            ]))
            
        return sizeEstimated
    }
}

module.exports = XChainEncoder