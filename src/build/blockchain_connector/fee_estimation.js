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

function uniqueTxids(txids) {
    const roots = []
    const seenRoots = new Set()
    for (const txid of (Array.isArray(txids) ? txids : [])) {
        if (typeof txid !== 'string' || txid.length === 0) continue
        const key = txid.toLowerCase()
        if (seenRoots.has(key)) continue
        seenRoots.add(key)
        roots.push(txid)
    }
    return roots
}

function recordPackageEntry(packageEntries, staged, txid, entry) {
    const key = String(txid).toLowerCase()
    if (packageEntries.has(key) || staged.has(key)) return true
    const size = entrySize(entry)
    const fee = entryFee(entry)
    if (size === null || fee === null) return false
    staged.set(key, { size, fee })
    return true
}

async function collectAncestorBranch(connector, packageEntries, txid) {
    // A root's two RPC calls are not atomic, so a block can confirm the
    // root between them; the node then answers the second call with -5.
    // Stage the branch and merge it only once both calls described the
    // same mempool, so a confirmed root's bytes and fee never reach the
    // package the child pays to accelerate.
    const staged = new Map()
    const self = await connector.mempoolRpc('getmempoolentry', [txid])
    if (!self.ok) {
        if (self.absent) return true        // already confirmed, nothing to carry
        return false
    }
    if (!recordPackageEntry(packageEntries, staged, txid, self.result)) return false

    // verbose=true: the ancestors come back as a txid-keyed map of the same
    // entries, so one call per input covers the whole branch above it.
    const ancestors = await connector.mempoolRpc('getmempoolancestors', [txid, true])
    if (!ancestors.ok) {
        // The root confirmed mid-sequence; its ancestors confirmed at or
        // before it did, so the whole staged branch is stale. Discard it.
        if (ancestors.absent) return true
        return false
    }
    const result = ancestors.result
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        for (const ancestorTxid of Object.keys(result)) {
            if (!recordPackageEntry(packageEntries, staged, ancestorTxid, result[ancestorTxid])) return false
        }
    } else {
        // A non-verbose (array) answer carries no size or fee, so the package
        // cannot be priced from it.
        return false
    }
    for (const [key, entry] of staged) packageEntries.set(key, entry)
    return true
}

function sumPackageEntries(packageEntries) {
    let size = 0
    let fees = 0
    for (const entry of packageEntries.values()) {
        size += entry.size
        fees += entry.fee
    }
    return { size, fees }
}

// On regtest, ALWAYS use the node's min-relay floor, never estimatesmartfee.
// Regtest coins are valueless and the smart estimate reflects accumulated
// test-tx history: on a long-lived regtest chain it balloons far above any
// sane rate (0.1386/kB = ~13859 sat/vB observed on a deep regtest chain),
// and a tx carrying that fee is rejected downstream by the caller's bitcoinjs
// checkFees safety cap, breaking every SDK-driven build. A fallback that only
// handles missing estimate data would still serve an inflated mature-chain
// estimate. relayfee is coin-correct (DOGE 0.001, BTC/LTC 0.00001) and reflects
// the node's actual config. Checked first so regtest skips estimatesmartfee
// entirely. isRegtest is memoized, so this costs one getblockchaininfo per
// connector lifetime, not per call.
async function regtestFee(connector) {
    try {
        const info = await connector.getNetworkInfo();
        const relayfee = Number(info && info.relayfee);
        if (relayfee > 0) return relayfee;
    } catch (_) {
        // Fall through to the conservative default below.
    }
    return 0.00001000
}

async function requestSmartFee(connector, blocksNumber) {
    const data = {
        jsonrpc: '2.0',
        method: 'estimatesmartfee',
        params: [blocksNumber],
        id: 1,
    };

    const response = await axios.post(connector.url, data, {
        auth: {
            username: connector.rpcUser,
            password: connector.rpcPassword,
        },
        timeout: RPC_TIMEOUT
    });

    return response.data;
}

// Non-regtest estimates must be positive and below the configured ceiling.
function usableSmartFee(responseData) {
    if (!responseData.result || !(Number(responseData.result.feerate) > 0)) return null
    const feerate = Number(responseData.result.feerate);
    const ceiling = feeEstimateSanityCeiling();
    if (feerate > ceiling) {
        logger.error('estimatesmartfee returned ' + feerate + '/kB on a non-regtest ' +
            'chain, above the ' + ceiling + '/kB sanity ceiling; clamping to the ceiling. ' +
            'Set FEE_ESTIMATE_SANITY_CEILING to override.');
        return ceiling;
    }
    return feerate;
}

// A public testnet can have too few transactions for estimatesmartfee. The
// fallback is a multiple of the node's min-relay floor, not the bare floor,
// because older nodes can classify a floor-rate transaction as free. Mainnet
// keeps throwing because a missing estimate there indicates an unhealthy node.
async function requireNoEstimateFallback(connector) {
    const fallback = await connector.noEstimateRelayFallback();
    if (fallback !== null) return fallback;
    throw new Error('Error getting smart fee from node');
}

// RPC implementations may report missing estimate data as an error body. Run
// the same non-mainnet fallback for that shape while preserving the original
// error when the chain or fallback query also fails.
async function recoverFeeEstimate(connector, error) {
    try {
        if (await connector.isRegtest()) return await regtestFee(connector)
        const fallback = await connector.noEstimateRelayFallback();
        if (fallback !== null) return fallback;
    } catch (_) {
        // The chain query or fallback RPC failed; rethrow the original error.
    }
    logger.error(util.format('Error:', sanitizeRpcError(error)));
    throw error;
}

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
     * entry this cannot read: the caller then prices the transaction on its own.
     */
    async getUnconfirmedAncestorPackage(txids) {
        const roots = uniqueTxids(txids)
        if (roots.length === 0) return { size: 0, fees: 0 }

        // txid -> {size, fee}. The dedupe surface for shared ancestors.
        const packageEntries = new Map()
        for (const txid of roots) {
            if (!await collectAncestorBranch(this, packageEntries, txid)) return null
        }
        return sumPackageEntries(packageEntries)
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
            if (await this.isRegtest()) return await regtestFee(this)
            const responseData = await requestSmartFee(this, blocksNumber)
            const feerate = usableSmartFee(responseData)
            if (feerate !== null) return feerate
            return await requireNoEstimateFallback(this)
        } catch (error) {
            return await recoverFeeEstimate(this, error)
        }
    },
}
