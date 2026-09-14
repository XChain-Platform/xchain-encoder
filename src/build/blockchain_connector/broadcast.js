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
const { sanitizeRpcError } = require('./rpc_helpers');

module.exports = {
    async sendRawTransaction(txHex) {
        try {
            return await this.sendRaw([txHex]);
        } catch (error) {
            // Regtest-only fee-cap recovery, mirroring xchain-e2e-test's
            // BlockchainConnector.broadcastTx. A regtest chain with accumulated
            // test-tx fee history can push fee rates up to (or past) the node's
            // default broadcast fee cap (0.10 coin/kvB on modern Bitcoin/Litecoin
            // Core), so a legitimately-built tx is rejected with "Fee exceeds
            // maximum configured by user (... maxfeerate)". Retry once with the
            // cap disabled (maxfeerate = 0 => unlimited). Gated on BOTH the cap
            // error AND the node reporting chain=regtest, so the numeric
            // maxfeerate arg is only ever sent to a node that just proved it
            // enforces the modern cap; Dogecoin Core 1.14 (2nd arg is a boolean
            // allowhighfees, not a maxfeerate) doesn't cap, so it never reaches
            // this branch.
            const msg = (error && error.message) || '';
            if (/maxfeerate|Fee exceeds maximum/i.test(msg)) {
                let regtest = false;
                try { regtest = await this.isRegtest(); } catch (_) { /* keep original error */ }
                if (regtest) {
                    return await this.sendRaw([txHex, 0]);
                }
            }
            throw error;
        }
    },

    // Single sendrawtransaction RPC to the coin node. `params` is [hex] or
    // [hex, maxfeerate]. Returns the txid; throws carrying the node's error body.
    async sendRaw(params) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'sendrawtransaction',
                params,
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
            logger.error(util.format('Error:', sanitizeRpcError(error)));
            throw error;
        }
    },

    // One JSON-RPC round trip for the mempool-inspection calls, which must never
    // break a build. Returns a verdict rather than throwing: {ok:true, result},
    // {ok:false, absent:true} for a txid the mempool does not hold (RPC -5, the
    // normal answer for an already-confirmed parent), or {ok:false} for anything
    // else. Mirrors sendRaw in reading the node's JSON-RPC error body off
    // error.response, because LTC/DOGE answer HTTP 500 for RPC-level errors.
    async mempoolRpc(method, params) {
        const classify = (rpcError) => {
            const code = rpcError && rpcError.code
            const message = (rpcError && rpcError.message) || ''
            if (code === -5 || /not in mempool|No such mempool/i.test(message)) {
                return { ok: false, absent: true }
            }
            return { ok: false }
        }
        try {
            const response = await axios.post(this.url, {
                jsonrpc: '2.0', method, params, id: 1,
            }, {
                auth: { username: this.rpcUser, password: this.rpcPassword },
                timeout: RPC_TIMEOUT
            })
            const body = response && response.data
            if (body && body.error) return classify(body.error)
            if (body && body.result !== undefined && body.result !== null) {
                return { ok: true, result: body.result }
            }
            return { ok: false }
        } catch (error) {
            const body = error.response && error.response.data
            if (body && body.error) return classify(body.error)
            logger.warn(util.format(`Mempool RPC ${method} failed:`, sanitizeRpcError(error)))
            return { ok: false }
        }
    },
}
