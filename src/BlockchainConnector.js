const fetch = require('cross-fetch')

class BlockchainConnector {
    constructor(url, port, rpcUser, rpcPassword) {
        this.url = "http://"+url+":"+port
        this.rpcUser = rpcUser
        this.rpcPassword = rpcPassword
    }
    
    async getNetworkInfo(){
        const data = {
            jsonrpc: '2.0',
            method: 'getnetworkinfo',
            id: 1
        };
        
        // Options configuration for fetch
        const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            },
            body: JSON.stringify(data)
        };

        try {
            // Make the request to the node
            const response = await fetch(this.url, options);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify if there is a result and return it
            if (responseData.result) {
                return responseData.result;
            } else {
                throw new Error('Error getting network info');
            }
        } catch (error) {
            throw new Error(`Error in network request: ${error.message}`);
        }
    }

    async getTransactionHex(txid, hexFormat = true) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getrawtransaction',
                params: [txid, hexFormat],
                id: 1,
            };

            // Options configuration for fetch
            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                },
                body: JSON.stringify(data)
            };

            // Make the request to the node
            const response = await fetch(this.url, options);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify if there is a result and return the hex
            if (responseData.result && responseData.result.hex) {
                return responseData.result.hex;
            } else {
                throw new Error('Error getting transaction hex');
            }
        } catch (error) {
            console.error('Error:', error.message);
            throw error;
        }
    }
    
    async getFeePerKilobyte(blocksNumber) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'estimatesmartfee',
                params: [blocksNumber],
                id: 1,
            };

            // Options configuration for fetch
            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                },
                body: JSON.stringify(data)
            };

            // Make the request to the node
            const response = await fetch(this.url, options);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify if there is a result and return the hex
            if (responseData.result && responseData.result.feerate) {
                return responseData.result.feerate;
            } else {
                throw new Error('Error getting smart fee from node');
            }
        } catch (error) {
            console.error('Error:', error.message);
            throw error;
        }
    }
}

module.exports = BlockchainConnector