const axios = require('axios');
axios.defaults.timeout = 5000

class UtxoTracker {
	constructor(url, port) {
		this.url = "http://"+url+":"+port
		this.port = port
	}
	
    async getUtxosFromAddress(address){
		const data = {
			jsonrpc: '2.0',
			method: 'get_utxos',
			id: 1
		}
		
		// Make the request to the node
		const response = await axios.post(this.url, data)

		// Verify if there is a result and return it
		if (response.data.result) {
			return response.data.result;
		} else {
			throw new Error('Error getting utxos');
		}
	}
}

module.exports = UtxoTracker