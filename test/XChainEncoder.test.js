// XChainEncoder.test.js
import { BIP32Factory } from 'bip32'
import ecc from 'tiny-secp256k1'
const bip32 = BIP32Factory(ecc)
import bip39 from 'bip39'
import bitcoin from 'bitcoinjs-lib'
import psbtutils from 'bitcoinjs-lib/src/psbt/psbtutils'
import assert from 'assert'
import XChainEncoder from '../src/XChainEncoder.js'
import nodeHelper from './nodeHelper.js'
import crypto from 'node:crypto'
import {ECPairFactory} from 'ecpair'

function xchainP2shFinalizer(inputIndex, input, script, isSegwit, isP2SH, isP2WSH){
    if (isP2SH){
        const decompiled = bitcoin.script.decompile(script);
        
        /*if (!decompiled 
          || decompiled[1] !== bitcoin.opcodes.OP_DROP
          || decompiled[2] !== bitcoin.opcodes.OP_DUP
          || decompiled[3] !== bitcoin.opcodes.OP_HASH160
          || decompiled[5] !== bitcoin.opcodes.OP_EQUALVERIFY
          || decompiled[6] !== bitcoin.opcodes.OP_CHECKSIG) {
            throw new Error(`Can not finalize input #${inputIndex}`);
        }*/
        
        let payment = {
            network: bitcoin.networks.regtest,
            input: 
                bitcoin.script.compile([
                    input.partialSig[0].signature,
                    input.partialSig[0].pubkey
                ]),
            output:script
        }
        
        payment = bitcoin.payments.p2sh({
            network: bitcoin.networks.regtest,
            redeem: payment,
        });
        
        return {
            finalScriptSig: payment.input,
            finalScriptWitness:undefined
        };  
    } else if (isP2WSH){
        const decompiled = bitcoin.script.decompile(script);
        
        let payment = {
            network: bitcoin.networks.regtest,
            input: 
                bitcoin.script.compile([
                    input.partialSig[0].signature,
                    input.partialSig[0].pubkey
                ]),
            output:script
        }
        
        payment = bitcoin.payments.p2wsh({
            network: bitcoin.networks.regtest,
            redeem: payment,
        });
        
        return {
            finalScriptSig: undefined,//payment.input,
            finalScriptWitness: psbtutils.witnessStackToScriptWitness(payment.witness)
        };  
    } else {
        throw new Error(`Can not finalize input #${inputIndex}. This finalizer is meant for only p2sh inputs`);
    }
    
    
    const decompiled = bitcoin.script.decompile(script);
    
}


describe('XChainEncoder', () => {
    describe('#createTransaction', () => {
        it('should create a simple OP_RETURN', async () => {
            var network = bitcoin.networks.regtest
        
            var mnemonic = bip39.generateMnemonic()
            console.log("The seed for OP_RETURN test is: " + mnemonic)

            var seed = bip39.mnemonicToSeedSync(mnemonic)
            var root = bip32.fromSeed(seed, network)
            var account = root.derivePath("m/44'/0'/0'/0")
            var address = account.derive(0).derive(0)
            var testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
            console.log("address for OP_RETURN: "+testAddress)

            let txId1 = await nodeClientTest.sendToAddress(testAddress, 1)
            let rawTx1 = await nodeClientTest.getRawTransaction(txId1, true)
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            let utxos = []
            let utxo1 = null
            for (let nextVoutIndex in rawTx1["vout"]){
                let nextVout = rawTx1["vout"][nextVoutIndex]
                
                if (("scriptPubKey" in nextVout) && ("address" in nextVout["scriptPubKey"]) && (nextVout["scriptPubKey"]["address"] == testAddress)){
                    utxo1 = {
                        "txid": rawTx1["txid"],
                        "vout": nextVout["n"],
                        "value": nextVout["value"]*100000000
                    }
                    
                    utxos.push(utxo1)
                    break
                }
            }
            
            // Configurar instancias y datos de prueba
            const encoder = new XChainEncoder("bitcoin-regtest", "127.0.0.1", "8333", "rpc", "rpc", "");
            const pubkey = testAddress;
            const customOutputs = {};
            const data = "Small data";
            const rawData = "Raw"
            const replacebyfee = true;
            const outputType = null;
            const changeAddress = testAddress;
            const exactFee = 10000;

            // Llamar a la función createTransaction
            console.log("Creating the transaction with XchainEncoder")
            const psbtResultante = await encoder.createTransaction(utxos, pubkey, customOutputs, data, rawData, exactFee, replacebyfee, outputType, changeAddress);
            const psbtBase64 = psbtResultante.toBase64()

            //Cargar el psbt
            const psbtParaFirmar = bitcoin.Psbt.fromBase64(psbtBase64)
            var ECPair = ECPairFactory(ecc);

            let keyToSign = ECPair.fromPrivateKey(address.privateKey, { network });

            for (let proxInputIndex in psbtParaFirmar.data.inputs){
                let proxInput = psbtParaFirmar.data.inputs[proxInputIndex]            
                psbtParaFirmar.signInput(parseInt(proxInputIndex), keyToSign);
            }
            
            psbtParaFirmar.finalizeAllInputs();
            
            console.log("Sending the OP_RETURN transaction to the node")
            txHex = psbtParaFirmar.extractTransaction().toHex()
            
            let txHash = await nodeHelper.broadcastTx(txHex)
            
            assert((txHash != null) && (txHash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            console.log("Obtaining the OP_RETURN transaction from the node")
            let txObj = await nodeHelper.getTransaction(txHash, false)
            
            console.log("Verifying the transaction structure and its data")
            assert(txObj["vin"].length == 1)
            assert(txObj["vout"].length == 2)
            
            let scriptPubKeyData = txObj["vout"][0]["scriptPubKey"]["hex"].substr(4,64)
            
            let txData = await nodeHelper.removeObfuscation(
                new Buffer.from(scriptPubKeyData, 'hex'),
                txObj["vin"][0]["txid"]
            )
            
            let txDataStr = txData.toString("utf-8")
            
			assert(txDataStr.substr(0,4) == "XCHN")
            
			let decompiledData = bitcoin.script.decompile(txData.slice(4))
			assert(decompiledData.length == 2)
            
			assert(decompiledData[0] == data)
			assert(decompiledData[1] == rawData)
        });
        it('should create a P2SH tx', async () => {
            var network = bitcoin.networks.regtest
        
            var mnemonic = bip39.generateMnemonic()
            console.log("The seed used for p2sh is: " + mnemonic)

            var seed = bip39.mnemonicToSeedSync(mnemonic)
            var root = bip32.fromSeed(seed, network)
            var account = root.derivePath("m/44'/0'/0'/0")
            var address = account.derive(0).derive(0)
            var testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
            console.log("address for P2SH: "+testAddress)

            let txId1 = await nodeClientTest.sendToAddress(testAddress, 1)
            let rawTx1 = await nodeClientTest.getRawTransaction(txId1, true)
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            let utxos = []
            let utxo1 = null
            for (let nextVoutIndex in rawTx1["vout"]){
                let nextVout = rawTx1["vout"][nextVoutIndex]
                
                if (("scriptPubKey" in nextVout) && ("address" in nextVout["scriptPubKey"]) && (nextVout["scriptPubKey"]["address"] == testAddress)){
                    utxo1 = {
                        "txid": rawTx1["txid"],
                        "vout": nextVout["n"],
                        "value": nextVout["value"]*100000000
                    }
                    
                    utxos.push(utxo1)
                    break
                }
            }
            
            // Configurar instancias y datos de prueba
            const encoder = new XChainEncoder("bitcoin-regtest", "127.0.0.1", "8333", "rpc", "rpc", "");
            const pubkey = testAddress;
            const customOutputs = {};
            const data = "Really big data for p2sh test, it should weight more than 80 bytes to use p2sh encode";
            const rawData = "Raw data should be big too"
            const replacebyfee = true;
            const outputType = null;
            const changeAddress = testAddress;
            const exactFee = 10000;

            // Llamar a la función createTransaction
            console.log("Creating the first transaction with XchainEncoder")
            const psbtResultante = await encoder.createTransaction(utxos, pubkey, customOutputs, data, rawData, exactFee, replacebyfee, outputType, changeAddress);
            const psbtBase64 = psbtResultante.toBase64()
            
            //Cargar el psbt
            const psbtParaFirmar = bitcoin.Psbt.fromBase64(psbtBase64)
            var ECPair = ECPairFactory(ecc);

            let keyToSign = ECPair.fromPrivateKey(address.privateKey, { network });

            for (let proxInputIndex in psbtParaFirmar.data.inputs){
                let proxInput = psbtParaFirmar.data.inputs[proxInputIndex]            
                psbtParaFirmar.signInput(parseInt(proxInputIndex), keyToSign);
            }
            
            psbtParaFirmar.finalizeAllInputs();
            let tx1 = psbtParaFirmar.extractTransaction()
            let tx1Hex = tx1.toHex()
            let tx1Id = tx1.getId()
            
            //Cargar el psbt2
            console.log("Creating the second transaction with XchainEncoder")
            const psbt2Resultante = await encoder.createTransaction(utxos, pubkey, customOutputs, data, rawData, exactFee, replacebyfee, outputType, changeAddress, tx1Id, tx1Hex);
            const psbt2Base64 = psbt2Resultante.toBase64()
            const psbt2ParaFirmar = bitcoin.Psbt.fromBase64(psbt2Base64)
            
            for (let proxInputIndex in psbt2ParaFirmar.data.inputs){
                //let proxInput = psbt2ParaFirmar.data.inputs[proxInputIndex]             
                let intIndex = parseInt(proxInputIndex)
                //psbt2ParaFirmar.updateInput(intIndex, {nonWitnessUtxo:Buffer.from(tx1Hex, 'hex')})
                psbt2ParaFirmar.signInput(intIndex, keyToSign);
            }
            
            //psbt2ParaFirmar.finalizeAllInputs();
            psbt2ParaFirmar.finalizeInput(0,xchainP2shFinalizer);
            
            let tx2 = psbt2ParaFirmar.extractTransaction()
            let tx2Hex = tx2.toHex()
            let tx2Id = tx2.getId()
            
            //Broadcast first p2sh tx
            console.log("Broadcasting the first p2sh transacion to the node")
            let txHash = await nodeHelper.broadcastTx(tx1Hex)
            
            assert((txHash != null) && (txHash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            console.log("Getting the first p2sh transacion from the node and verifying its structure")
            let txObj = await nodeHelper.getTransaction(txHash, false)
            assert(txObj["vin"].length == 1)
            assert(txObj["vout"].length == 2)
            
            //Broadcast second p2sh tx
            console.log("Broadcasting the second p2sh transacion to the node")
            let tx2Hash = await nodeHelper.broadcastTx(tx2Hex)
            assert((tx2Hash != null) && (tx2Hash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            console.log("Getting the second p2sh transacion from the node and verifying its structure and its data")
            let tx2Obj = await nodeHelper.getTransaction(tx2Hash, false)
            assert(tx2Obj["vin"].length == 1)
            assert(tx2Obj["vout"].length == 1)
            
            let scriptPubKeyData = tx2Obj["vout"][0]["scriptPubKey"]["hex"].substr(4,64)
            let txData = await nodeHelper.removeObfuscation(
                new Buffer.from(scriptPubKeyData, 'hex'),
                tx2Obj["vin"][0]["txid"]
            )
            
			let txDataStr = txData.toString("utf-8")
            
            assert(txDataStr.substr(0,4) == "XCHN")
            assert(txDataStr.substr(4) == "p2sh")
            
            let decodedScriptSig = bitcoin.script.decompile(Buffer.from(tx2Obj["vin"][0]["scriptSig"]["hex"], "hex"))
            let decodedRedeemScript = bitcoin.script.decompile(decodedScriptSig[2])
            let decodedData = Buffer.from(decodedRedeemScript[0],"hex")//.toString("utf-8")
			
			
			let decompiledData = bitcoin.script.decompile(decodedData)
			assert(decompiledData.length == 2)
            
			assert(decompiledData[0] == data)
			assert(decompiledData[1] == rawData)
			
            //assert(decodedData == data)
        });
        it('should create a multisign tx', async () => {
            var network = bitcoin.networks.regtest
        
            var mnemonic = bip39.generateMnemonic()
            console.log("The seed used for multisign is: " + mnemonic)

            var seed = bip39.mnemonicToSeedSync(mnemonic)
            var root = bip32.fromSeed(seed, network)
            var account = root.derivePath("m/44'/0'/0'/0")
            var address = account.derive(0).derive(0)
            
            var testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
            console.log("address for multisig: "+testAddress)

            let txId1 = await nodeClientTest.sendToAddress(testAddress, 1)
            let rawTx1 = await nodeClientTest.getRawTransaction(txId1, true)
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            let utxos = []
            let utxo1 = null
            for (let nextVoutIndex in rawTx1["vout"]){
                let nextVout = rawTx1["vout"][nextVoutIndex]
                
                if (("scriptPubKey" in nextVout) && ("address" in nextVout["scriptPubKey"]) && (nextVout["scriptPubKey"]["address"] == testAddress)){
                    utxo1 = {
                        "txid": rawTx1["txid"],
                        "vout": nextVout["n"],
                        "value": nextVout["value"]*100000000
                    }
                    
                    utxos.push(utxo1)
                    break
                }
            }
            
            // Configurar instancias y datos de prueba
            const encoder = new XChainEncoder("bitcoin-regtest", "127.0.0.1", "8333", "rpc", "rpc", "");
            const pubkey = testAddress;
            const customOutputs = {};
            const data = "Data for only one multisign output";
            const rawData = "Raw"
            const replacebyfee = true;
            const outputType = "MULTISIGN";
            const changeAddress = testAddress;
            const exactFee = 10000;
            const compressedPubKey = address.publicKey.toString("hex")


            // Llamar a la función createTransaction
            console.log("Creating the first transaction with XchainEncoder")
            const psbtResultante = await encoder.createTransaction(utxos, pubkey, customOutputs, data, rawData, exactFee, replacebyfee, outputType, changeAddress, null, null, compressedPubKey);
            const psbtBase64 = psbtResultante.toBase64()
            
            //Cargar el psbt
            const psbtParaFirmar = bitcoin.Psbt.fromBase64(psbtBase64)
            var ECPair = ECPairFactory(ecc);

            let keyToSign = ECPair.fromPrivateKey(address.privateKey, { network });

            for (let proxInputIndex in psbtParaFirmar.data.inputs){
                let proxInput = psbtParaFirmar.data.inputs[proxInputIndex]            
                psbtParaFirmar.signInput(parseInt(proxInputIndex), keyToSign);
            }
            
            psbtParaFirmar.finalizeAllInputs();
            let tx1 = psbtParaFirmar.extractTransaction()
            let tx1Hex = tx1.toHex()
            let tx1Id = tx1.getId()
            
            //Broadcast multisign tx
            console.log("Broadcasting the multisign transacion to the node")
            let txHash = await nodeHelper.broadcastTx(tx1Hex)
            
            assert((txHash != null) && (txHash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            console.log("Getting the multisign transaction from the node and verifying its structure")
            let txObj = await nodeHelper.getTransaction(txHash, false)
            
            assert(txObj["vin"].length == 1)
            assert(txObj["vout"].length == 2)
            
            
            let scriptPubKeyData = Buffer.from(txObj["vout"][0]["scriptPubKey"]["hex"],"hex")
            let decompiledScript = bitcoin.script.decompile(scriptPubKeyData)
            
            let pubkey1 = decompiledScript[1].subarray(1) //removing the 02 at the beginning
            let pubkey2 = decompiledScript[2].subarray(1) //removing the 02 at the beginning
            //let pubkey3 = decompiledScript[3]
            
            let dataConcat = Buffer.concat([pubkey1, pubkey2])
            
            for (let i=dataConcat.length - 1;i>=0;i--){
                if (dataConcat[i] !== 0){
                    dataConcat = dataConcat.slice(0, i + 1)
                    break
                }
            }
            
            
            let decodedData = await nodeHelper.removeObfuscation(dataConcat, txObj["vin"][0]["txid"])
            decodedDataString = decodedData.toString("utf-8")
            //decodedData = decodedDataString.substr()
            
            assert(decodedDataString.substr(0,4) == "XCHN")
			
			let decompiledData = bitcoin.script.decompile(decodedData.slice(4))
			assert(decompiledData.length == 2)
            
			assert(decompiledData[0] == data)
			assert(decompiledData[1] == rawData)
			
            //assert(decodedData.substr(4) == data)
        });
        it('should create a P2WSH tx', async () => {
            var network = bitcoin.networks.regtest
        
            var mnemonic = bip39.generateMnemonic()
            console.log("The seed used for p2wsh is: " + mnemonic)

            var seed = bip39.mnemonicToSeedSync(mnemonic)
            var root = bip32.fromSeed(seed, network)
            var account = root.derivePath("m/44'/0'/0'/0")
            var address = account.derive(0).derive(0)
            var testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
            console.log("address for P2WSH: "+testAddress)

            let txId1 = await nodeClientTest.sendToAddress(testAddress, 1)
            let rawTx1 = await nodeClientTest.getRawTransaction(txId1, true)
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            let utxos = []
            let utxo1 = null
            for (let nextVoutIndex in rawTx1["vout"]){
                let nextVout = rawTx1["vout"][nextVoutIndex]
                
                if (("scriptPubKey" in nextVout) && ("address" in nextVout["scriptPubKey"]) && (nextVout["scriptPubKey"]["address"] == testAddress)){
                    utxo1 = {
                        "txid": rawTx1["txid"],
                        "vout": nextVout["n"],
                        "value": nextVout["value"]*100000000
                    }
                    
                    utxos.push(utxo1)
                    break
                }
            }
            
            // Configurar instancias y datos de prueba
            const encoder = new XChainEncoder("bitcoin-regtest", "127.0.0.1", "8333", "rpc", "rpc", "");
            const pubkey = testAddress;
            const customOutputs = {};
            const data = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1ABCDEFGHIJKLMNOPQRSTUVWXYZ2ABCDEFGHIJKLMNOPQRSTUVWXYZ3ABCDEFGHIJKLMNOPQRSTUVWXYZ4ABCDEFGHIJKLMNOPQRSTUVWXYZ5ABCDEFGHIJKLMNOPQRSTUVWXYZ6ABCDEFGHIJKLMNOPQRSTUVWXYZ7ABCDEFGHIJKLMNOPQRSTUVWXYZ8";
            const rawData = "Raw"
            const replacebyfee = true;
            const outputType = "P2WSH";
            const changeAddress = testAddress;
            const exactFee = 10000;

            // Llamar a la función createTransaction
            console.log("Creating the first transaction with XchainEncoder")
            const psbtResultante = await encoder.createTransaction(utxos, pubkey, customOutputs, data, rawData, exactFee, replacebyfee, outputType, changeAddress);
            const psbtBase64 = psbtResultante.toBase64()
            
            //Cargar el psbt
            const psbtParaFirmar = bitcoin.Psbt.fromBase64(psbtBase64)
            var ECPair = ECPairFactory(ecc);

            let keyToSign = ECPair.fromPrivateKey(address.privateKey, { network });

            for (let proxInputIndex in psbtParaFirmar.data.inputs){
                let proxInput = psbtParaFirmar.data.inputs[proxInputIndex]            
                psbtParaFirmar.signInput(parseInt(proxInputIndex), keyToSign);
            }
            
            psbtParaFirmar.finalizeAllInputs();
            let tx1 = psbtParaFirmar.extractTransaction()
            let tx1Hex = tx1.toHex()
            let tx1Id = tx1.getId()
            
            //Cargar el psbt2
            console.log("Creating the second transaction with XchainEncoder")
            const psbt2Resultante = await encoder.createTransaction(utxos, pubkey, customOutputs, data, rawData, exactFee, replacebyfee, outputType, changeAddress, tx1Id, tx1Hex);
            const psbt2Base64 = psbt2Resultante.toBase64()
            const psbt2ParaFirmar = bitcoin.Psbt.fromBase64(psbt2Base64)
            
            for (let proxInputIndex in psbt2ParaFirmar.data.inputs){
                let intIndex = parseInt(proxInputIndex)
                psbt2ParaFirmar.signInput(intIndex, keyToSign);
            }
            
            psbt2ParaFirmar.finalizeInput(0,xchainP2shFinalizer);
            //psbt2ParaFirmar.finalizeInput(0);
            
            let tx2 = psbt2ParaFirmar.extractTransaction()
            let tx2Hex = tx2.toHex()
            let tx2Id = tx2.getId()
            
            //Broadcast first p2wsh tx
            console.log("Broadcasting the first p2wsh transacion to the node")
            let txHash = await nodeHelper.broadcastTx(tx1Hex)
            
            assert((txHash != null) && (txHash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            console.log("Getting the first p2wsh transacion from the node and verifying its structure")
            let txObj = await nodeHelper.getTransaction(txHash, false)
            assert(txObj["vin"].length == 1)
            assert(txObj["vout"].length == 2)
            
            //Broadcast second p2wsh tx
            console.log("Broadcasting the second p2wsh transacion to the node")
            let tx2Hash = await nodeHelper.broadcastTx(tx2Hex)
            assert((tx2Hash != null) && (tx2Hash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)
            
            console.log("Getting the second p2wsh transacion from the node and verifying its structure and its data")
            let tx2Obj = await nodeHelper.getTransaction(tx2Hash, false)
            assert(tx2Obj["vin"].length == 1)
            assert(tx2Obj["vout"].length == 1)
            
            let scriptPubKeyData = tx2Obj["vout"][0]["scriptPubKey"]["hex"].substr(4,64)
            let txData = await nodeHelper.removeObfuscation(
                new Buffer.from(scriptPubKeyData, 'hex'),
                tx2Obj["vin"][0]["txid"]
            )
            let txDataStr = txData.toString("utf-8")
            
            assert(txDataStr.substr(0,4) == "XCHN")
            assert(txDataStr.substr(4) == "p2wsh")
            
            let decodedRedeemScript = bitcoin.script.decompile(Buffer.from(tx2Obj["vin"][0]["txinwitness"][2], "hex"))
            let decodedData = Buffer.from(decodedRedeemScript[0],"hex")//.toString("utf-8")
			
			let decompiledData = bitcoin.script.decompile(decodedData)
			assert(decompiledData.length == 2)
            
			assert(decompiledData[0] == data)
			assert(decompiledData[1] == rawData)
			
            //assert(decodedData == data)
        });
    });
});