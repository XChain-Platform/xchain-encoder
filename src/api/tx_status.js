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
 * XChain Encoder - transaction status
 *
 * Classifies a txid as in the node mempool, confirmed in the tracker's chain
 * index, or unknown, refusing to call it unknown on a view that cannot prove it.
 *
 ********************************************************************/

const { callerSafeError } = require('../common/error_sanitize')

// Every tracker lookup costs a slot in the tracker's per-IP request budget, which all
// encoder callers share, so a status answer reuses the sync status the lookup's own
// readiness gate read: an unknown answer costs 3 tracker requests, a chain answer 2.

function committedHeight(sync){
    return Number.isSafeInteger(sync.committed_height) ? sync.committed_height : sync.tracker_height
}

// Why `before` cannot vouch for a miss at `nodeTip`, or null when it can. The tracker
// must have committed the node tip BEFORE the decisive lookup ran, since the node
// drops a confirmed transaction from its mempool the moment it accepts the block
// while the tracker commits that block a poll later. The node tip is read after the
// mempool miss, so any block that could hold the transaction is at or below it.
function uncoveredTip(before, nodeTip){
    const trackerTip = committedHeight(before)
    if (!Number.isSafeInteger(nodeTip) || nodeTip < 0) return 'cannot compare against an unknown node tip'
    if (!Number.isSafeInteger(trackerTip) || trackerTip < nodeTip) return 'has not committed the node tip'
    return null
}

// Why `before` and `after` describe a moving chain, or null when they are one view: a
// committed height that fell, a reorg recorded across the lookup, or a different tip
// hash at the same height.
function movedDuringLookup(before, after){
    const trackerTip = committedHeight(before)
    if (!Number.isSafeInteger(committedHeight(after)) || committedHeight(after) < trackerTip) return 'rolled back during the lookup'
    if (Number.isSafeInteger(before.reorg_count) && Number.isSafeInteger(after.reorg_count) &&
        before.reorg_count !== after.reorg_count) return 'recorded a reorg during the lookup'
    if (typeof before.committed_hash === 'string' && typeof after.committed_hash === 'string' &&
        before.committed_hash !== after.committed_hash && after.committed_height === before.committed_height){
        return 'switched chain tips during the lookup'
    }
    return null
}

function indeterminate(reason){
    return callerSafeError(`utxo-tracker ${reason}; transaction status is indeterminate, retry`)
}

// Both fast lookups missed. `fastSync` is the snapshot taken just before the fast
// tracker lookup. When it already covers the node tip, that lookup is the decisive
// one; otherwise repeat the lookup once, so a block the tracker committed after the
// fast miss is found rather than hidden. Then re-read the sync status to prove the
// view held still, and re-read the mempool, which a reorg before the snapshot refills.
async function classifyUnseenTx(encoder, txid, fastSync){
    const tracker = encoder.utxoTrackerConnector
    const nodeTip = await encoder.connector.getBlockCount()
    let before = fastSync
    if (uncoveredTip(before, nodeTip)) {
        const relook = await tracker.lookupTxBlock(txid)
        if (relook.block !== null) return { status: 'chain' }
        before = relook.sync
        const reason = uncoveredTip(before, nodeTip)
        if (reason) throw indeterminate(reason)
    }
    const reason = movedDuringLookup(before, await tracker.getSyncStatus())
    if (reason) throw indeterminate(reason)
    if (await encoder.connector.getMempoolEntry(txid) !== null) return { status: 'mempool' }
    return { status: 'unknown' }
}

async function getTxStatus(encoder, txid){
    if (await encoder.connector.getMempoolEntry(txid) !== null) return { status: 'mempool' }
    const fast = await encoder.utxoTrackerConnector.lookupTxBlock(txid)
    if (fast.block !== null) return { status: 'chain' }
    return classifyUnseenTx(encoder, txid, fast.sync)
}

module.exports = { getTxStatus }
