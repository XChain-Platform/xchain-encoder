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

const { BIP32Factory } = require('bip32')
const ecc = require('tiny-secp256k1')
const bip32 = BIP32Factory(ecc)
const bip39 = require('bip39')
const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');
const assert = require('assert');

const apiUrl = "127.0.0.1:3000"

async function sendToApi(method, params){
	try {
		const data = {
			jsonrpc: '2.0',
			"method": method,
			"params": params,
			id: 1,
		}

		// Realizar la solicitud JSON-RPC al nodo
		const response = await axios.post("http://"+apiUrl, data)

		// Verificar si la solicitud fue exitosa y devolver el hex de la transacción
		if (response.data.result) {
			return response.data.result;
		} else {
			console.log(response)
			throw new Error('Error al hacer la llamada json-rpc');
		}
	} catch (error) {
		console.error('Error:', error.message);
		throw error;
	}
}


describe('api', () => {
	describe('#create_tx', () => {	
		it('should create a simple tx from api', async () => {
			var network = bitcoin.networks.regtest
			var mnemonic = bip39.generateMnemonic()
			console.log("The seed for the api test is: " + mnemonic)

			var seed = bip39.mnemonicToSeedSync(mnemonic)
			var root = bip32.fromSeed(seed, network)
			var account = root.derivePath("m/44'/0'/0'/0")
			var address = account.derive(0).derive(0)
			var testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
			console.log("address for api test: "+testAddress)

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
			
			let response = await sendToApi("create_tx",
				{
					"utxosList":utxos,
					"pubkey":testAddress,
					"customOutputs":{},
					"data":"simple text",
					"exactFee":1000,
					"rbf":true,
					"outputType":null,
					"changeAddress":testAddress
				}
			)
			
			console.log(response)
			assert("psbt" in response)
			
		})
	})
})