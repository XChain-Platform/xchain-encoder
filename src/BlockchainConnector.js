/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Encoder - Blockchain Connector Class
 * 
 * This file handles pulling blockchain data from a coin daemon
 * 
 ********************************************************************/

// Load required libraries
const fetch = require('cross-fetch')

const RPC_TIMEOUT = parseInt(process.env.NODE_RPC_TIMEOUT ?? '30000', 10)

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

        // Abort the request if the node does not respond within 15 seconds
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT);

        try {
            // Make the request to the node
            const response = await fetch(this.url, { ...options, signal: controller.signal });

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
        } finally {
            clearTimeout(timer);
        }
    }

    async isRegtest(){
        const data = {
            jsonrpc: '2.0',
            method: 'getblockchaininfo',
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

        // Abort the request if the node does not respond within 15 seconds
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT);

        try {
            // Make the request to the node
            const response = await fetch(this.url, { ...options, signal: controller.signal });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseData = await response.json();

            // Verify if there is a result and return it
            if (responseData.result && responseData.result.chain) {
                return responseData.result.chain == "regtest"
            } else {
                throw new Error('Error getting blockchain info');
            }
        } catch (error) {
            throw new Error(`Error in network request: ${error.message}`);
        } finally {
            clearTimeout(timer);
        }
    }

    async getTransactionHex(txid, hexFormat = true) {
        // Abort the request if the node does not respond within 15 seconds
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT);

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
            const response = await fetch(this.url, { ...options, signal: controller.signal });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseData = await response.json();

            // Verify if there is a result and return the hex
            if (responseData.result && responseData.result.hex) {
                return responseData.result.hex;
            } else if (responseData.error?.code === -5) {
                // RPC -5: tx not in mempool and not retrievable. For confirmed
                // transactions this typically means the coin node lacks txindex.
                throw new Error(`Transaction ${txid} not found — the coin node may require txindex=1 to retrieve confirmed transactions`);
            } else {
                throw new Error('Error getting transaction hex');
            }
        } catch (error) {
            console.error('Error:', error);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
    
    async sendRawTransaction(txHex) {
        // Abort the request if the node does not respond within 15 seconds
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT);

        try {
            const data = {
                jsonrpc: '2.0',
                method: 'sendrawtransaction',
                params: [txHex],
                id: 1,
            };

            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                },
                body: JSON.stringify(data)
            };

            const response = await fetch(this.url, { ...options, signal: controller.signal });

            // bitcoind/litecoind/dogecoind return HTTP 500 for RPC-level errors
            // (e.g. a rejected tx) WITH a JSON-RPC error body. Read the body even
            // on a non-2xx status so the node's actual reason (e.g.
            // "non-mandatory-script-verify-flag", "dust", "bad-txns-*") is
            // surfaced instead of a useless "HTTP error! status: 500".
            const responseData = await response.json().catch(() => null);

            if (responseData && responseData.error) {
                throw new Error(responseData.error.message || JSON.stringify(responseData.error));
            }

            if (!response.ok || !responseData) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            if (responseData.result) {
                return responseData.result;
            } else {
                throw new Error('Error broadcasting transaction: empty result');
            }
        } catch (error) {
            console.error('Error:', error);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async getFeePerKilobyte(blocksNumber) {
        // Abort the request if the node does not respond within 15 seconds
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT);

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
            const response = await fetch(this.url, { ...options, signal: controller.signal });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify if there is a result and return the hex
            if (responseData.result && responseData.result.feerate) {
                return responseData.result.feerate;
            } else {
                if (await this.isRegtest()){
                    return 0.00001000
                } else {
                    throw new Error('Error getting smart fee from node');
                }
            }
        } catch (error) {
            console.error('Error:', error);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

module.exports = BlockchainConnector