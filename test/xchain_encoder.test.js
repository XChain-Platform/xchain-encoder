/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

import { BIP32Factory } from 'bip32'
import * as ecc from 'tiny-secp256k1'
const bip32 = BIP32Factory(ecc)
import bip39 from 'bip39'
import bitcoin from 'bitcoinjs-lib'
import assert from 'assert'
import XChainEncoder from '../src/XChainEncoder.js'
import nodeHelper from './helpers/node_helper.js'
import {ECPairFactory} from 'ecpair'


async function loadOpReturnFunds () {
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

            return { network, address, testAddress, utxos }
}

async function createOpReturnTransaction ({ network, address, testAddress, utxos }) {
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

            return { txHash, data, rawData }
}

describe('XChainEncoder', () => {
    describe('#createTransaction', () => {
        it('should create a simple OP_RETURN', async () => {
            const { txHash, data, rawData } = await createOpReturnTransaction(await loadOpReturnFunds())

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
    });
});
