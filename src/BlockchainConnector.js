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

const axios = require('axios')

const RPC_TIMEOUT = parseInt(process.env.NODE_RPC_TIMEOUT ?? '30000', 10)

// Sanitize an axios error before it is logged or re-thrown. RPC calls pass
// auth:{username,password} to axios, which attaches the request config to the
// thrown error, so logging the raw error serializes the node RPC password into
// the encoder logs (util.inspect walks error.config.auth). Scrub the credential
// fields in place so neither this logger nor any upstream handler leaks them, and
// return a compact, credential-free string (error.message never carries auth).
// Kept in sync with xchain-decoder/src/BlockchainConnector.js sanitizeRpcError.
function sanitizeRpcError(error){
    try {
        if (error && error.config) {
            error.config.auth = undefined
            if (error.config.headers) delete error.config.headers.Authorization
        }
        if (error && error.request) error.request = undefined
        if (error && error.response) {
            const status = error.response.status
            error.response = (status !== undefined) ? { status: status } : undefined
        }
    } catch (_) { /* sanitization must never mask the original failure */ }
    return (error && error.message) ? error.message : String(error)
}

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
                throw new Error('Error getting network info');
            }
        } catch (error) {
            throw new Error(`Error in network request: ${error.message}`);
        }
    }

    async isRegtest(){
        // A connector's node never changes chain over its lifetime, so memoize the
        // answer. getFeePerKilobyte now consults this on every fee lookup (to force
        // the relayfee floor on regtest), and without caching that would add a
        // getblockchaininfo round-trip to every tx build on all networks.
        if (this._isRegtestCache !== undefined) return this._isRegtestCache;
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
                this._isRegtestCache = responseData.result.chain == "regtest";
                return this._isRegtestCache;
            } else {
                throw new Error('Error getting blockchain info');
            }
        } catch (error) {
            throw new Error(`Error in network request: ${error.message}`);
        }
    }

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
    }

    async getTransactionHex(txid, hexFormat = true) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getrawtransaction',
                params: [txid, hexFormat],
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
            console.error('Error:', sanitizeRpcError(error));
            throw error;
        }
    }

    async sendRawTransaction(txHex) {
        try {
            return await this._sendRaw([txHex]);
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
                    return await this._sendRaw([txHex, 0]);
                }
            }
            throw error;
        }
    }

    // Single sendrawtransaction RPC to the coin node. `params` is [hex] or
    // [hex, maxfeerate]. Returns the txid; throws carrying the node's error body.
    async _sendRaw(params) {
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
            console.error('Error:', sanitizeRpcError(error));
            throw error;
        }
    }

    async getFeePerKilobyte(blocksNumber) {
        try {
            // On regtest, ALWAYS use the node's min-relay floor, never estimatesmartfee.
            // Regtest coins are valueless and the smart estimate reflects accumulated
            // test-tx history: on a long-lived regtest chain it balloons far above any
            // sane rate (0.1386/kB = ~13859 sat/vB observed on a deep regtest chain),
            // and a tx carrying that fee is rejected downstream by the caller's bitcoinjs
            // checkFees safety cap, breaking every SDK-driven build. The earlier version
            // only fell back to relayfee when estimatesmartfee returned NO data (a fresh
            // chain), so a matured regtest chain silently served the inflated estimate.
            // relayfee is coin-correct (DOGE 0.001, BTC/LTC 0.00001) and reflects the
            // node's actual config. Checked first so regtest skips estimatesmartfee
            // entirely (its value is unused there). isRegtest is memoized, so this is
            // one getblockchaininfo per connector lifetime, not per call.
            if (await this.isRegtest()){
                try {
                    const info = await this.getNetworkInfo();
                    const relayfee = Number(info && info.relayfee);
                    if (relayfee > 0) {
                        return relayfee;
                    }
                } catch (e) {
                    // Fall through to the conservative default below.
                }
                return 0.00001000
            }

            const data = {
                jsonrpc: '2.0',
                method: 'estimatesmartfee',
                params: [blocksNumber],
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

            // Non-regtest: use estimatesmartfee. Guard on > 0 so a zero/negative
            // sentinel (feerate:-1, not enough data) is treated as an error rather
            // than silently returned.
            if (responseData.result && Number(responseData.result.feerate) > 0) {
                return responseData.result.feerate;
            } else {
                throw new Error('Error getting smart fee from node');
            }
        } catch (error) {
            // On a fresh regtest chain estimatesmartfee can error (not enough
            // data) rather than just returning feerate:-1. Try the relayfee
            // fallback before propagating so regtest builds still get a valid
            // fee rate even when the RPC layer returns an error body.
            try {
                if (await this.isRegtest()) {
                    try {
                        const info = await this.getNetworkInfo();
                        const relayfee = Number(info && info.relayfee);
                        if (relayfee > 0) {
                            return relayfee;
                        }
                    } catch (_) {
                        // Fall through to the rethrow below.
                    }
                    return 0.00001000;
                }
            } catch (_) {
                // isRegtest() itself failed; fall through to rethrow.
            }
            console.error('Error:', sanitizeRpcError(error));
            throw error;
        }
    }
}

module.exports = BlockchainConnector
