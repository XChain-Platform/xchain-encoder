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
import XChainEncoder from '../../src/XChainEncoder.js'
import nodeHelper from '../helpers/node_helper.js'
import {ECPairFactory} from 'ecpair'



async function loadMultisignFunds () {
            const network = bitcoin.networks.regtest

            const mnemonic = bip39.generateMnemonic()
            console.log("The seed used for multisign is: " + mnemonic)

            const seed = bip39.mnemonicToSeedSync(mnemonic)
            const root = bip32.fromSeed(seed, network)
            const account = root.derivePath("m/44'/0'/0'/0")
            const address = account.derive(0).derive(0)

            const testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
            console.log("address for multisig: "+testAddress)

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

async function createMultisignTransaction ({ network, address, testAddress, utxos }) {
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

            return { tx1Hex, data, rawData }
}

describe('XChainEncoder', () => {
    describe('#createTransaction', () => {
        it('should create a multisign tx', async () => {
            const { tx1Hex, data, rawData } = await createMultisignTransaction(await loadMultisignFunds())

            //Broadcast multisign tx
            console.log("Broadcasting the multisign transacion to the node")
            const txHash = await nodeHelper.broadcastTx(tx1Hex)

            assert((txHash != null) && (txHash.length == 64))
            await nodeClientTest.generateToAddress(1, mainTestAddress)

            console.log("Getting the multisign transaction from the node and verifying its structure")
            const txObj = await nodeHelper.getTransaction(txHash, false)

            assert(txObj["vin"].length == 1)
            assert(txObj["vout"].length == 2)


            const scriptPubKeyData = Buffer.from(txObj["vout"][0]["scriptPubKey"]["hex"],"hex")
            const decompiledScript = bitcoin.script.decompile(scriptPubKeyData)

            const pubkey1 = decompiledScript[1].subarray(1) //removing the 02 at the beginning
            const pubkey2 = decompiledScript[2].subarray(1) //removing the 02 at the beginning

            let dataConcat = Buffer.concat([pubkey1, pubkey2])

            for (let i=dataConcat.length - 1;i>=0;i--){
                if (dataConcat[i] !== 0){
                    dataConcat = dataConcat.slice(0, i + 1)
                    break
                }
            }


            const decodedData = await nodeHelper.removeObfuscation(dataConcat, txObj["vin"][0]["txid"])
            decodedDataString = decodedData.toString("utf-8")

            assert(decodedDataString.substr(0,4) == "XCHN")

			const decompiledData = bitcoin.script.decompile(decodedData.slice(4))
			assert(decompiledData.length == 2)

			assert(decompiledData[0] == data)
			assert(decompiledData[1] == rawData)

        });
    });
});
