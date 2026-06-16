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
 **********************************************************************
 *
 * XChain Encoder - Blockchain Connector Class
 *
 * This file handles pulling blockchain data from a coin daemon
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios')

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

        try {
            // Make the request to the node
            const response = await axios.post(this.url, data, {
                auth: {
                    username: this.rpcUser,
                    password: this.rpcPassword,
                },
                timeout: RPC_TIMEOUT
            });

            const responseData = response.data;

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

    async isRegtest(){
        const data = {
            jsonrpc: '2.0',
            method: 'getblockchaininfo',
            id: 1
        };

        try {
            // Make the request to the node
            const response = await axios.post(this.url, data, {
                auth: {
                    username: this.rpcUser,
                    password: this.rpcPassword,
                },
                timeout: RPC_TIMEOUT
            });

            const responseData = response.data;

            // Verify if there is a result and return it
            if (responseData.result && responseData.result.chain) {
                return responseData.result.chain == "regtest"
            } else {
                throw new Error('Error getting blockchain info');
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

            // Make the request to the node
            const response = await axios.post(this.url, data, {
                auth: {
                    username: this.rpcUser,
                    password: this.rpcPassword,
                },
                timeout: RPC_TIMEOUT
            });

            const responseData = response.data;

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
        }
    }

    async sendRawTransaction(txHex) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'sendrawtransaction',
                params: [txHex],
                id: 1,
            };

            const response = await axios.post(this.url, data, {
                auth: {
                    username: this.rpcUser,
                    password: this.rpcPassword,
                },
                timeout: RPC_TIMEOUT
            });

            const responseData = response.data;

            if (responseData && responseData.error) {
                throw new Error(responseData.error.message || JSON.stringify(responseData.error));
            }

            if (responseData && responseData.result) {
                return responseData.result;
            } else {
                throw new Error('Error broadcasting transaction: empty result');
            }
        } catch (error) {
            // bitcoind/litecoind/dogecoind return HTTP 500 for RPC-level errors
            // (e.g. a rejected tx) WITH a JSON-RPC error body. axios throws on a
            // non-2xx status, so read the node's error body off error.response so
            // its actual reason (e.g. "non-mandatory-script-verify-flag", "dust",
            // "bad-txns-*") is surfaced instead of a useless "status code 500".
            const body = error.response?.data;
            if (body && body.error) {
                throw new Error(body.error.message || JSON.stringify(body.error));
            }
            console.error('Error:', error);
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

            // Make the request to the node
            const response = await axios.post(this.url, data, {
                auth: {
                    username: this.rpcUser,
                    password: this.rpcPassword,
                },
                timeout: RPC_TIMEOUT
            });

            const responseData = response.data;

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
        }
    }
}

module.exports = BlockchainConnector
