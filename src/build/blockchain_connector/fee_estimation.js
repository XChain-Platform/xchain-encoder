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
const {
    entrySize,
    entryFee,
    noEstimateRelayMultiplier,
    feeEstimateSanityCeiling,
    sanitizeRpcError,
} = require('./rpc_helpers');

module.exports = {
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
        const record = (staged, txid, entry) => {
            const key = String(txid).toLowerCase()
            if (packageEntries.has(key) || staged.has(key)) return true
            const size = entrySize(entry)
            const fee = entryFee(entry)
            if (size === null || fee === null) return false
            staged.set(key, { size, fee })
            return true
        }

        for (const txid of roots) {
            // A root's two RPC calls are not atomic, so a block can confirm the
            // root between them; the node then answers the second call with -5.
            // Stage the branch and merge it only once both calls described the
            // same mempool, so a confirmed root's bytes and fee never reach the
            // package the child pays to accelerate.
            const staged = new Map()
            const self = await this.mempoolRpc('getmempoolentry', [txid])
            if (!self.ok) {
                if (self.absent) continue        // already confirmed, nothing to carry
                return null
            }
            if (!record(staged, txid, self.result)) return null

            // verbose=true: the ancestors come back as a txid-keyed map of the same
            // entries, so one call per input covers the whole branch above it.
            const ancestors = await this.mempoolRpc('getmempoolancestors', [txid, true])
            if (!ancestors.ok) {
                // The root confirmed mid-sequence; its ancestors confirmed at or
                // before it did, so the whole staged branch is stale. Discard it.
                if (ancestors.absent) continue
                return null
            }
            const result = ancestors.result
            if (result && typeof result === 'object' && !Array.isArray(result)) {
                for (const ancestorTxid of Object.keys(result)) {
                    if (!record(staged, ancestorTxid, result[ancestorTxid])) return null
                }
            } else {
                // A non-verbose (array) answer carries no size or fee, so the package
                // cannot be priced from it.
                return null
            }
            for (const [key, entry] of staged) packageEntries.set(key, entry)
        }

        let size = 0
        let fees = 0
        for (const entry of packageEntries.values()) {
            size += entry.size
            fees += entry.fee
        }
        return { size, fees }
    },

    // The "node has no fee estimate" fallback for non-mainnet chains: a multiple
    // of the node's own min-relay floor, or null when it does not apply (mainnet,
    // or a node that reports no usable relayfee). Null means the caller throws.
    // Consulted from both shapes the condition arrives in, the feerate:-1 success
    // body and an RPC error body, so the two paths cannot drift apart.
    async noEstimateRelayFallback() {
        if ((await this.chainName()) === 'main') return null;
        const info = await this.getNetworkInfo();
        const relayfee = Number(info && info.relayfee);
        if (!(relayfee > 0)) return null;
        const multiplier = noEstimateRelayMultiplier();
        const feerate = relayfee * multiplier;
        logger.warn('estimatesmartfee returned no estimate on a non-mainnet chain; using ' +
            multiplier + 'x the node relayfee floor: ' + feerate + '/kB ' +
            '(FEE_NO_ESTIMATE_RELAY_MULTIPLIER to change)');
        return feerate;
    },

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
                const feerate = Number(responseData.result.feerate);
                const ceiling = feeEstimateSanityCeiling();
                if (feerate > ceiling) {
                    // Loud diagnostic: this is a money-affecting path and a clamp here
                    // is silent everywhere else unless it is logged at error level.
                    logger.error('estimatesmartfee returned ' + feerate + '/kB on a non-regtest ' +
                        'chain, above the ' + ceiling + '/kB sanity ceiling; clamping to the ceiling. ' +
                        'Set FEE_ESTIMATE_SANITY_CEILING to override.');
                    return ceiling;
                }
                return feerate;
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
            const fallback = await this.noEstimateRelayFallback();
            if (fallback !== null) return fallback;
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
                // A node can report the same "no estimate" condition with an RPC
                // error instead of feerate:-1 (LTC/DOGE answer HTTP 500 with a
                // JSON-RPC error body, so axios throws before the try-block's
                // fallback is reached). Run the same non-mainnet fallback here, or
                // a public testnet in that state fails every fee-bearing build
                // with nothing wrong at the node. Mainnet still returns null and
                // rethrows, and a genuinely unreachable node makes the fallback's
                // own RPCs throw, so node-down stays a hard failure.
                const fallback = await this.noEstimateRelayFallback();
                if (fallback !== null) return fallback;
            } catch (_) {
                // isRegtest() or the fallback's own RPC failed; fall through to rethrow.
            }
            logger.error(util.format('Error:', sanitizeRpcError(error)));
            throw error;
        }
    },
}
