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

// Why `before` and `after` cannot vouch for a miss at `nodeTip`, or null when they can.
// The tracker must have committed the node tip BEFORE the decisive lookup ran, since
// the node drops a confirmed transaction from its mempool the moment it accepts the
// block while the tracker commits that block a poll later. A committed height that
// fell, a reorg recorded across the lookup, or a different tip hash at the same
// height means it read a moving chain.
function committedHeight(sync){
    return Number.isSafeInteger(sync.committed_height) ? sync.committed_height : sync.tracker_height
}

function unprovenMiss(before, after, nodeTip){
    const trackerTip = committedHeight(before)
    if (!Number.isSafeInteger(nodeTip) || nodeTip < 0) return 'cannot compare against an unknown node tip'
    if (!Number.isSafeInteger(trackerTip) || trackerTip < nodeTip) return 'has not committed the node tip'
    if (!Number.isSafeInteger(committedHeight(after)) || committedHeight(after) < trackerTip) return 'rolled back during the lookup'
    if (Number.isSafeInteger(before.reorg_count) && Number.isSafeInteger(after.reorg_count) &&
        before.reorg_count !== after.reorg_count) return 'recorded a reorg during the lookup'
    if (typeof before.committed_hash === 'string' && typeof after.committed_hash === 'string' &&
        before.committed_hash !== after.committed_hash && after.committed_height === before.committed_height){
        return 'switched chain tips during the lookup'
    }
    return null
}

// Both fast lookups missed. Repeat the tracker lookup inside a sync snapshot taken
// first, so a block the tracker committed after the fast miss is found rather than
// hidden, then re-read the mempool, which a reorg before the snapshot refills.
async function classifyUnseenTx(encoder, txid){
    const tracker = encoder.utxoTrackerConnector
    const before = await tracker.getSyncStatus()
    const nodeTip = await encoder.connector.getBlockCount()
    if (await tracker.getTxBlock(txid) !== null) return { status: 'chain' }
    const after = await tracker.getSyncStatus()
    const reason = unprovenMiss(before, after, nodeTip)
    if (reason) throw callerSafeError(`utxo-tracker ${reason}; transaction status is indeterminate, retry`)
    if (await encoder.connector.getMempoolEntry(txid) !== null) return { status: 'mempool' }
    return { status: 'unknown' }
}

async function getTxStatus(encoder, txid){
    if (await encoder.connector.getMempoolEntry(txid) !== null) return { status: 'mempool' }
    if (await encoder.utxoTrackerConnector.getTxBlock(txid) !== null) return { status: 'chain' }
    return classifyUnseenTx(encoder, txid)
}

module.exports = { getTxStatus }
