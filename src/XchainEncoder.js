const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');
const BitcoinCore = require('bitcoin-core');
const crypto = require('crypto');
const bs58check = require('bs58check')
const BlockchainConnector = require('./BlockchainConnector')
const CryptoNetworks = require('./CryptoNetworks')
const UtxoTracker = require('./UtxoTracker')

const OP_RETURN_SIZE = 80
const P2SH_SIZE = 520
const PW2SH_SIZE = 10000
const MULTISIGN_SIZE = 71
const MAGIC_WORD = "XCHN"

const OutputType = {
	OP_RETURN: "OP_RETURN",
	P2SH: "P2SH",
	MULTISIGN: "MULTISIGN",
	P2WSH: "P2WSH"
}


class XChainEncoder {
	constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, utxoTrackerUrl, utxoTrackerPort) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
	  this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
	  this.utxoTrackerConnector = new UtxoTracker(utxoTrackerUrl, utxoTrackerPort)
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
			if (data.length <= OP_RETURN_SIZE) {
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
		
		var cipher = crypto.createCipheriv('aes-128-cbc', cipherKey, iv);
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
	async createTransaction(utxosList, pubkey, customOutputs, data, exactFee, replacebyfee, outputType, changeAddress, p2shHash=null, p2shHex=null, compressedPubKey=null){
		let dataBuffer = Buffer.from(data, 'utf8')
		let psbt = null
		
		let utxoSequence = (replacebyfee? 0x00000001: 0xffffffff)
		let txidFirstInput = null
		let inputSatoshis = 0

		if ((utxosList == null) || (utxosList.length == 0)){
			utxosList = UtxoTracker.getUtxosFromAddress(pubkey)
			
			if ((utxosList == null) || (utxosList.length == 0)){
				throw new Error("no utxos were provided and no utxos found on the blockchain")
			}
		}

	

		if (!p2shHash){//We need to prepare the data to know which inputs the p2sh will have
			psbt = new bitcoin.Psbt({ network: this.network })
				
			for (let nextUtxoIndex in utxosList){
				let nextUtxo = utxosList[nextUtxoIndex]
				
				if (!txidFirstInput){
					txidFirstInput = nextUtxo["txid"]
				}
				
				if (this.isSegwitUTXO(nextUtxo)){
					psbt.addInput({
						hash: nextUtxo.txid,
						index: nextUtxo.vout,
						sequence: utxoSequence,
						witnessUtxo: {
							script: Buffer.from(nextUtxo.scriptPubKey, 'hex'),
							value: nextUtxo.value,
						},
					})
					
					inputSatoshis = inputSatoshis + nextUtxo.value
				} else {
					let wholeUtxoHex = await this.connector.getTransactionHex(nextUtxo.txid)
					psbt.addInput({
						hash: nextUtxo.txid,
						index: nextUtxo.vout,
						sequence: utxoSequence,
						nonWitnessUtxo: Buffer.from(wholeUtxoHex, 'hex')
					})
					
					inputSatoshis = inputSatoshis + nextUtxo.value
				}
			}
		}

		let preparedData = this.prepareData(dataBuffer, outputType, pubkey)
		
		let outputSatoshis = 0
		let voutPsbtIndex = 0
		let obfuscatedData
		
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
					break
				case OutputType.P2SH:
					if (p2shHex){
						let p2shTx = bitcoin.Transaction.fromHex(p2shHex)
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
												Buffer.from("p2sh",'utf8')
											]),
											txidFirstInput
										)
									]
								}).output,
								value: 0
							})
						}
						
						psbt.addInput({
							sequence: utxoSequence,
							hash:p2shHash,
							redeemScript:nextDataBuffer,
							index: voutPsbtIndex,
							nonWitnessUtxo:Buffer.from(p2shHex, 'hex')
						})
						
						voutPsbtIndex = voutPsbtIndex + 1					
					} else {
						psbt.addOutput({
							address: bitcoin.payments.p2sh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
							value:1000
						})
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
						
						psbt.addInput({
							sequence: utxoSequence,
							hash:p2shHash,
							//redeem:{output:nextDataBuffer},
							witnessScript:nextDataBuffer,
							index: voutPsbtIndex,
							witnessUtxo:{
								script:p2shTx["outs"][voutPsbtIndex]["script"], 
								value:p2shTx["outs"][voutPsbtIndex]["value"]
							}
						})
						
						voutPsbtIndex = voutPsbtIndex + 1					
					} else {
						psbt.addOutput({
							address: bitcoin.payments.p2wsh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
							value:1000
						})
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
					break	
			}
		}
		
		let changeSatoshis = inputSatoshis - outputSatoshis - exactFee
		
		if ((changeSatoshis > 0) && (changeAddress)) {
			psbt.addOutput({
				address: changeAddress,
				value: changeSatoshis
			})
		}
		
		return psbt
	}
}

module.exports = XChainEncoder