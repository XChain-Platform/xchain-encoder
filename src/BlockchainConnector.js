const axios = require('axios');
axios.defaults.timeout = 5000

class BlockchainConnector {
	constructor(url, rpcUser, rpcPassword) {
		this.url = url
		this.rpcUser = rpcUser
		this.rpcPassword = rpcPassword
	}
	
    async getNetworkInfo(){
		const data = {
			jsonrpc: '2.0',
			method: 'getnetworkinfo',
			id: 1
		}
		
		// Make the request to the node
		const response = await axios.post(this.url, data, {
			auth: {
				username: this.rpcUser,
				password: this.rpcPassword,
			},
		})

		// Verify if there is a result and return it
		if (response.data.result) {
			return response.data.result;
		} else {
			throw new Error('Error getting transaction');
		}
	}

	async getTransactionHex(txid, hexFormat=true) {
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getrawtransaction',
				params: [txid, hexFormat],
				id: 1,
			}

			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				},
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result.hex;
			} else {
				throw new Error('Error getting transaction');
			}
		} catch (error) {
			console.error('Error:', error.message);
			throw error;
		}
	}
}

module.exports = BlockchainConnector