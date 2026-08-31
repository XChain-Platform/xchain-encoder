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
// Fee-rate multiple of the node's relay floor used on non-mainnet chains when
// estimatesmartfee has no data. Rationale at getFeePerKilobyte.
//
// Ten is the documented recommended rate, and on Dogecoin testnet it is NOT
// enough to be mined: measured over 400 blocks there, transactions land at
// 0.03 and around 1.0 DOGE per kB, while 0.0102 sat unmined for an hour. The
// one that did land below that paid 0.0044 and got in on legacy coin-age
// priority, which a chain of freshly spent change can never have. So the
// multiple is deployment-tunable: a quiet chain whose miners ignore the
// documented rate needs a higher one, and only the operator running that chain
// can measure what it actually takes.
function noEstimateRelayMultiplier(){
    const raw = parseFloat(process.env.FEE_NO_ESTIMATE_RELAY_MULTIPLIER)
    return (Number.isFinite(raw) && raw > 0) ? raw : 10
}

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

// Size and fee off one getmempoolentry-shaped record, across both field layouts
// the fleet's nodes use: Core 0.14 (Dogecoin 1.14) reports flat `size` and `fee`,
// while modern Core reports `vsize` and nests the fee under `fees.base`. Either
// reader returns null on a value it cannot price, which the caller treats as an
// unusable package rather than as a zero-fee ancestor.
function entrySize(entry){
    const raw = entry && (entry.vsize !== undefined ? entry.vsize : entry.size)
    const size = Number(raw)
    return (Number.isFinite(size) && size > 0) ? size : null
}

function entryFee(entry){
    const raw = entry && (entry.fees && entry.fees.base !== undefined ? entry.fees.base : entry.fee)
    const fee = Number(raw)
    return (Number.isFinite(fee) && fee >= 0) ? fee : null
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
        return (await this.chainName()) === 'regtest';
    }

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

    // One JSON-RPC round trip for the mempool-inspection calls, which must never
    // break a build. Returns a verdict rather than throwing: {ok:true, result},
    // {ok:false, absent:true} for a txid the mempool does not hold (RPC -5, the
    // normal answer for an already-confirmed parent), or {ok:false} for anything
    // else. Mirrors _sendRaw in reading the node's JSON-RPC error body off
    // error.response, because LTC/DOGE answer HTTP 500 for RPC-level errors.
    async _mempoolRpc(method, params) {
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
            console.warn(`Mempool RPC ${method} failed:`, sanitizeRpcError(error))
            return { ok: false }
        }
    }

    /**
     * The unconfirmed ancestor package behind a set of input txids, as
     * {size, fees}: total bytes and total fee in COIN units (the unit
     * getmempoolentry reports, and the unit getFeePerKilobyte returns).
     *
     * A miner selects by ancestor fee rate, not by the rate of one transaction, so
     * a child spending unconfirmed parents only gets mined when the whole package
     * clears the block-inclusion floor. Sizing that child needs the package it
     * inherits, which is this.
     *
     * Every entry is keyed by txid in one map, so two inputs that share a parent
     * (or a grandparent) count that ancestor once; double counting would inflate
     * the package and overpay. Txids the mempool does not hold are confirmed and
     * contribute nothing. Returns null when the node cannot answer or reports an
     * entry this cannot read: the caller then prices the transaction on its own,
     * which is what it did before package sizing existed.
     */
    async getUnconfirmedAncestorPackage(txids) {
        const roots = []
        const seenRoots = new Set()
        for (const txid of (Array.isArray(txids) ? txids : [])) {
            if (typeof txid !== 'string' || txid.length === 0) continue
            const key = txid.toLowerCase()
            if (seenRoots.has(key)) continue
            seenRoots.add(key)
            roots.push(txid)
        }
        if (roots.length === 0) return { size: 0, fees: 0 }

        // txid -> {size, fee}. The dedupe surface for shared ancestors.
        const packageEntries = new Map()
        const record = (txid, entry) => {
            const key = String(txid).toLowerCase()
            if (packageEntries.has(key)) return true
            const size = entrySize(entry)
            const fee = entryFee(entry)
            if (size === null || fee === null) return false
            packageEntries.set(key, { size, fee })
            return true
        }

        for (const txid of roots) {
            const self = await this._mempoolRpc('getmempoolentry', [txid])
            if (!self.ok) {
                if (self.absent) continue        // already confirmed, nothing to carry
                return null
            }
            if (!record(txid, self.result)) return null

            // verbose=true: the ancestors come back as a txid-keyed map of the same
            // entries, so one call per input covers the whole branch above it.
            const ancestors = await this._mempoolRpc('getmempoolancestors', [txid, true])
            if (!ancestors.ok) {
                if (ancestors.absent) continue
                return null
            }
            const result = ancestors.result
            if (result && typeof result === 'object' && !Array.isArray(result)) {
                for (const ancestorTxid of Object.keys(result)) {
                    if (!record(ancestorTxid, result[ancestorTxid])) return null
                }
            } else {
                // A non-verbose (array) answer carries no size or fee, so the package
                // cannot be priced from it.
                return null
            }
        }

        let size = 0
        let fees = 0
        for (const entry of packageEntries.values()) {
            size += entry.size
            fees += entry.fee
        }
        return { size, fees }
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
            }
            // No estimate at all (feerate:-1). A public TESTNET routinely has too few
            // transactions to estimate from: DOGE testnet answers -1 with an empty
            // mempool and a fully synced node, and every fee-bearing broadcast (the
            // oracle's PRICE batches among them) then fails at "Internal encoder
            // error" with nothing wrong at the node. Fall back to a multiple of the
            // node's min-relay floor on any non-mainnet chain. NOT the bare floor:
            // Dogecoin 1.14 still runs Bitcoin Core 0.14's free-transaction
            // priority gate, under which a tx paying only the relay floor counts as
            // "free" and is rejected with "66: insufficient priority" unless its
            // inputs are old and large. Regtest relaxes that gate in the node's
            // config; a public testnet's peers do not, so the fallback has to pay a
            // fee the gate never sees. 10x the floor is Dogecoin's own published
            // recommended rate (0.01 DOGE/kB against a 0.001 floor), and on BTC/LTC
            // testnets it is 10 sat/vB, cheap in coin that costs nothing.
            // Mainnet keeps throwing: there a missing estimate means the node is
            // unhealthy, and paying real coin on a guess is the worse failure.
            if ((await this.chainName()) !== 'main') {
                const info = await this.getNetworkInfo();
                const relayfee = Number(info && info.relayfee);
                if (relayfee > 0) {
                    const multiplier = noEstimateRelayMultiplier();
                    const feerate = relayfee * multiplier;
                    console.warn('estimatesmartfee returned no estimate on a non-mainnet chain; using ' +
                        multiplier + 'x the node relayfee floor: ' + feerate + '/kB ' +
                        '(FEE_NO_ESTIMATE_RELAY_MULTIPLIER to change)');
                    return feerate;
                }
            }
            throw new Error('Error getting smart fee from node');
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
