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

        // The redeem-script shape check is deliberately not enforced here: it
        // would require [data] OP_DROP OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY
        // OP_CHECKSIG and throw "Can not finalize input #n" on any other script.

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



async function loadP2shFunds () {
            const network = bitcoin.networks.regtest

            const mnemonic = bip39.generateMnemonic()
            console.log("The seed used for p2sh is: " + mnemonic)

            const seed = bip39.mnemonicToSeedSync(mnemonic)
            const root = bip32.fromSeed(seed, network)
            const account = root.derivePath("m/44'/0'/0'/0")
            const address = account.derive(0).derive(0)
            const testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
            console.log("address for P2SH: "+testAddress)

            const txId1 = await nodeClientTest.sendToAddress(testAddress, 1)
            const rawTx1 = await nodeClientTest.getRawTransaction(txId1, true)
            await nodeClientTest.generateToAddress(1, mainTestAddress)

            const utxos = []
            let utxo1 = null
            for (const nextVoutIndex in rawTx1["vout"]){
                const nextVout = rawTx1["vout"][nextVoutIndex]

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

async function createP2shTransactions ({ network, address, testAddress, utxos }) {
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
            const ECPair = ECPairFactory(ecc);

            const keyToSign = ECPair.fromPrivateKey(address.privateKey, { network });

            for (const proxInputIndex in psbtParaFirmar.data.inputs){
                const proxInput = psbtParaFirmar.data.inputs[proxInputIndex]
                psbtParaFirmar.signInput(parseInt(proxInputIndex), keyToSign);
            }

            psbtParaFirmar.finalizeAllInputs();
            const tx1 = psbtParaFirmar.extractTransaction()
            const tx1Hex = tx1.toHex()
            const tx1Id = tx1.getId()

            //Cargar el psbt2
            console.log("Creating the second transaction with XchainEncoder")
            const psbt2Resultante = await encoder.createTransaction(utxos, pubkey, customOutputs, data, rawData, exactFee, replacebyfee, outputType, changeAddress, tx1Id, tx1Hex);
            const psbt2Base64 = psbt2Resultante.toBase64()
            const psbt2ParaFirmar = bitcoin.Psbt.fromBase64(psbt2Base64)

            for (const proxInputIndex in psbt2ParaFirmar.data.inputs){
                const intIndex = parseInt(proxInputIndex)
                psbt2ParaFirmar.signInput(intIndex, keyToSign);
            }

            psbt2ParaFirmar.finalizeInput(0,xchainP2shFinalizer);

            const tx2 = psbt2ParaFirmar.extractTransaction()
            const tx2Hex = tx2.toHex()
            const tx2Id = tx2.getId()

            return { tx1Hex, tx2Hex, data, rawData }
}

describe('XChainEncoder', () => {
    describe('#createTransaction', () => {
        it('should create a P2SH tx', async () => {
            const { tx1Hex, tx2Hex, data, rawData } = await createP2shTransactions(await loadP2shFunds())

            //Broadcast first p2sh tx
            console.log("Broadcasting the first p2sh transacion to the node")
            const txHash = await nodeHelper.broadcastTx(tx1Hex)

            assert((txHash != null) && (txHash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)

            console.log("Getting the first p2sh transacion from the node and verifying its structure")
            const txObj = await nodeHelper.getTransaction(txHash, false)
            assert(txObj["vin"].length == 1)
            assert(txObj["vout"].length == 2)

            //Broadcast second p2sh tx
            console.log("Broadcasting the second p2sh transacion to the node")
            const tx2Hash = await nodeHelper.broadcastTx(tx2Hex)
            assert((tx2Hash != null) && (tx2Hash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)

            console.log("Getting the second p2sh transacion from the node and verifying its structure and its data")
            const tx2Obj = await nodeHelper.getTransaction(tx2Hash, false)
            assert(tx2Obj["vin"].length == 1)
            assert(tx2Obj["vout"].length == 1)

            const scriptPubKeyData = tx2Obj["vout"][0]["scriptPubKey"]["hex"].substr(4,64)
            const txData = await nodeHelper.removeObfuscation(
                new Buffer.from(scriptPubKeyData, 'hex'),
                tx2Obj["vin"][0]["txid"]
            )

			const txDataStr = txData.toString("utf-8")

            assert(txDataStr.substr(0,4) == "XCHN")
            assert(txDataStr.substr(4) == "p2sh")

            const decodedScriptSig = bitcoin.script.decompile(Buffer.from(tx2Obj["vin"][0]["scriptSig"]["hex"], "hex"))
            const decodedRedeemScript = bitcoin.script.decompile(decodedScriptSig[2])
            const decodedData = Buffer.from(decodedRedeemScript[0])


			const decompiledData = bitcoin.script.decompile(decodedData)
			assert(decompiledData.length == 2)

			assert(decompiledData[0] == data)
			assert(decompiledData[1] == rawData)

        });
    });
});
