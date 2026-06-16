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

const crypto = require('crypto');

const rpcUser = 'rpc';
const rpcPassword = 'rpc';
const rpcPort = 8333;

class BitcoinRpcClient {
	constructor({ username, password, port, wallet }) {
		this._auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
		this._base = `http://localhost:${port}`;
		this._wallet = wallet || null;
	}

	async _rpc(method, params = []) {
		const url = this._wallet
			? `${this._base}/wallet/${this._wallet}`
			: this._base;
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': this._auth },
			body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
		});
		const data = await resp.json();
		if (data.error) throw new Error(data.error.message);
		return data.result;
	}

	listWallets()                      { return this._rpc('listwallets'); }
	createWallet(name)                 { return this._rpc('createwallet', [name]); }
	getNewAddress()                    { return this._rpc('getnewaddress'); }
	generateToAddress(n, addr)         { return this._rpc('generatetoaddress', [n, addr]); }
	getBalance()                       { return this._rpc('getbalance'); }
	sendToAddress(addr, amount)        { return this._rpc('sendtoaddress', [addr, amount]); }
	getRawTransaction(txid, verbose)   { return this._rpc('getrawtransaction', [txid, verbose]); }
}

module.exports = {
	async getWalletConnection(walletName) {
		let params = { username: rpcUser, password: rpcPassword, port: rpcPort };
		let connection = new BitcoinRpcClient(params);

		const walletList = await connection.listWallets();

		if (!walletList.includes(walletName)) {
			console.log('Creating wallet ' + walletName);
			await connection.createWallet(walletName);
		}

		return new BitcoinRpcClient({ ...params, wallet: walletName });
	},

	async broadcastTx(txHex) {
		const auth = 'Basic ' + Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64');
		const resp = await fetch(`http://localhost:${rpcPort}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'sendrawtransaction', params: [txHex], id: 1 }),
		});
		const data = await resp.json();
		if (!data.result) throw new Error('Error al enviar la transacción');
		return data.result;
	},

	async getTransaction(txid, hexFormat = true) {
		const auth = 'Basic ' + Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64');
		const resp = await fetch(`http://localhost:${rpcPort}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'getrawtransaction', params: [txid, !hexFormat], id: 1 }),
		});
		const data = await resp.json();
		if (!data.result) throw new Error('Error al obtener la transacción');
		return data.result;
	},

	async removeObfuscation(data, txid) {
		var cipherKey = txid.substr(0, 16);
		var iv = txid.substr(16, 16);
		var decipher = crypto.createDecipheriv('aes-128-cbc', cipherKey, iv);
		var decryptedData = decipher.update(data);
		decryptedData = Buffer.concat([decryptedData, decipher.final()]);
		return decryptedData;
	}
};
