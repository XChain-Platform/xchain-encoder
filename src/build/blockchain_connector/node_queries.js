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
const { chainTierMismatch } = require('./chain_identity');
const { OperationalError } = require('../errors');

module.exports = {
    // Refuse a node whose getblockchaininfo chain is a recognized tier other than the configured network.
    // (Fails open, warning once, when no network was configured or the chain cannot be read; a pass is cached.)
    async assertNodeTier(){
        if (!this.consensusNetwork || this.nodeTierOk) return;
        let chain;
        try {
            chain = await this.chainName();
        } catch (error) {
            if (!this.nodeTierWarned) logger.warn(`Node chain tier unchecked: ${error && error.message}`);
            this.nodeTierWarned = true;
            return;
        }
        const reason = chainTierMismatch(this.consensusNetwork, chain);
        if (reason) throw new OperationalError('NODE_CHAIN_MISMATCH', 'Coin node is on the wrong network: ' + reason);
        this.nodeTierOk = true;
    },


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
            const body = response && response.data;
            // Treat an error body, an empty body or a missing result as unknown.
            if (!body || typeof body !== 'object') return null;
            if (body.error !== undefined && body.error !== null) return null;
            // Type before coercion: Number(null), Number('') and Number(false) are a
            // finite 0, which the envelope gate would read as a real tip at genesis.
            const height = body.result;
            return (Number.isSafeInteger(height) && height >= 0) ? height : null;
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
                // Keep the node's reason from an HTTP 200 error body (BTC v28's shape).
                throw new Error('Error getting transaction hex' + rpcErrorDetail(responseData));
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
            // Read any other node reason (-28 warming up, -8) before the scrub
            // drops error.response, so it is not flattened to "status code 500".
            const detail = rpcErrorDetail(body);
            const message = sanitizeRpcError(error);
            logger.error(util.format('Error:', message + detail));
            // No RPC body: a transport failure keeps its original error object.
            if (!detail) throw error;
            throw new Error(`Error getting transaction hex: ${message}${detail}`);
        }
    },
}
