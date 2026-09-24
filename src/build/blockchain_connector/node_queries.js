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

const axios = require('axios')
const util = require('node:util');
const { logger, RPC_TIMEOUT } = require('./constants');
const { sanitizeRpcError, rpcErrorDetail } = require('./rpc_helpers');

module.exports = {
    async getNetworkInfo(){
        const data = {
            jsonrpc: '2.0',
            method: 'getnetworkinfo',
            id: 1
        };

        try {
            const response = await axios.post(this.url, data, {
                auth: {
                    username: this.rpcUser,
                    password: this.rpcPassword,
                },
                timeout: RPC_TIMEOUT
            });

            const responseData = response.data;

            if (responseData.result) {
                return responseData.result;
            } else {
                throw new Error('Error getting network info' + rpcErrorDetail(responseData));
            }
        } catch (error) {
            // Keep the node's reason: a warming node answers -28 "Loading block
            // index...", which is otherwise flattened to "status code 500".
            const detail = rpcErrorDetail(error.response && error.response.data);
            throw new Error(`Error in network request: ${sanitizeRpcError(error)}${detail}`);
        }
    },

    async isRegtest(){
        return (await this.chainName()) === 'regtest';
    },

    // The node's chain name from getblockchaininfo ('main', 'test', 'regtest',
    // 'signet'). A connector's node never changes chain over its lifetime, so
    // memoize the answer: getFeePerKilobyte consults it on every fee lookup, and
    // without caching that would add a getblockchaininfo round-trip to every tx
    // build on all networks.
    async chainName(){
        if (this._chainNameCache !== undefined) return this._chainNameCache;
        const data = {
            jsonrpc: '2.0',
            method: 'getblockchaininfo',
            id: 1
        };

        try {
            const response = await axios.post(this.url, data, {
                auth: {
                    username: this.rpcUser,
                    password: this.rpcPassword,
                },
                timeout: RPC_TIMEOUT
            });

            const responseData = response.data;

            if (responseData.result && responseData.result.chain) {
                this._chainNameCache = String(responseData.result.chain);
                return this._chainNameCache;
            } else {
                throw new Error('Error getting blockchain info' + rpcErrorDetail(responseData));
            }
        } catch (error) {
            // Same reason as getNetworkInfo: preserve the node's own RPC code
            // and message rather than the bare HTTP status.
            const detail = rpcErrorDetail(error.response && error.response.data);
            throw new Error(`Error in network request: ${sanitizeRpcError(error)}${detail}`);
        }
    },

    // Current chain tip. Used by the TAPROOT envelope build to refuse an
    // envelope below its network's recognition height, since a reveal the fleet
    // ignores costs the caller real coin for an action that never exists. Returns
    // null rather than throwing when the node cannot answer: the caller decides
    // whether an unknown height should block the build (it does, fail-closed).
    async getBlockCount() {
        try {
            const response = await axios.post(this.url, {
                jsonrpc: '2.0', method: 'getblockcount', params: [], id: 1,
            }, {
                auth: { username: this.rpcUser, password: this.rpcPassword },
                timeout: RPC_TIMEOUT
            });
            const height = response && response.data && response.data.result;
            return Number.isFinite(Number(height)) ? Number(height) : null;
        } catch (error) {
            return null;
        }
    },

    async getTransactionHex(txid) {
        try {
            // The second param is the node's verbose flag: true answers an object
            // carrying .hex (read below), false a bare hex string.
            const data = {
                jsonrpc: '2.0',
                method: 'getrawtransaction',
                params: [txid, true],
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

            if (responseData.result && responseData.result.hex) {
                return responseData.result.hex;
            } else if (responseData.error?.code === -5) {
                // RPC -5: tx not in mempool and not retrievable. For confirmed
                // transactions this typically means the coin node lacks txindex.
                throw new Error(`Transaction ${txid} not found (the coin node may require txindex=1 to retrieve confirmed transactions)`);
            } else {
                throw new Error('Error getting transaction hex');
            }
        } catch (error) {
            // LTC/DOGE return HTTP 500 for RPC-level errors so axios throws before
            // the success branch above is reached. Mirror sendRawTransaction: inspect
            // the node's JSON-RPC error body off error.response so the -5 txindex
            // hint is surfaced on all chains, not only BTC v28 (which returns HTTP 200).
            const body = error.response?.data;
            if (body && body.error?.code === -5) {
                throw new Error(`Transaction ${txid} not found (the coin node may require txindex=1 to retrieve confirmed transactions)`);
            }
            logger.error(util.format('Error:', sanitizeRpcError(error)));
            throw error;
        }
    },
}
