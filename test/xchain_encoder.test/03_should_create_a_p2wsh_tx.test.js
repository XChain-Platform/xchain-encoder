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
import psbtutils from 'bitcoinjs-lib/src/psbt/psbtutils.js'
import assert from 'assert'
import XChainEncoder from '../../src/XChainEncoder.js'
import nodeHelper from '../helpers/node_helper.js'
import {ECPairFactory} from 'ecpair'

function xchainP2shFinalizer(inputIndex, input, script, isSegwit, isP2SH, isP2WSH){
    if (isP2SH){
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
            finalScriptSig: undefined,
            finalScriptWitness: psbtutils.witnessStackToScriptWitness(payment.witness)
        };
    } else {
        throw new Error(`Can not finalize input #${inputIndex}. This finalizer is meant for only p2sh inputs`);
    }


    const decompiled = bitcoin.script.decompile(script);

}



async function loadP2wshFunds () {
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

            return { network, address, testAddress, utxos }
}

async function createP2wshTransactions ({ network, address, testAddress, utxos }) {
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

            let tx2 = psbt2ParaFirmar.extractTransaction()
            let tx2Hex = tx2.toHex()
            let tx2Id = tx2.getId()

            return { tx1Hex, tx2Hex, data, rawData }
}

describe('XChainEncoder', () => {
    describe('#createTransaction', () => {
        it('should create a P2WSH tx', async () => {
            const { tx1Hex, tx2Hex, data, rawData } = await createP2wshTransactions(await loadP2wshFunds())

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
            let decodedData = Buffer.from(decodedRedeemScript[0])

			let decompiledData = bitcoin.script.decompile(decodedData)
			assert(decompiledData.length == 2)

			assert(decompiledData[0] == data)
			assert(decompiledData[1] == rawData)

        });
    });
});
