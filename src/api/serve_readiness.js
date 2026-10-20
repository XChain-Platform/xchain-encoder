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
 * XChain Encoder - serve-readiness probe
 *
 * The readiness probe behind the JSON-RPC health() method and GET /status,
 * built by a factory over the encoder instance the entry owns.
 *
 ********************************************************************/

const XChainEncoder  = require('../XChainEncoder');

// Cap the tier check well under NODE_RPC_TIMEOUT: a failed chain read is not
// cached, so an unreachable node would otherwise hold every probe for 30s.
const NODE_TIER_PROBE_DEADLINE_MS = 3000

// Serve-readiness probe shared by the JSON-RPC health() method and GET
// /status, so the two endpoints can never drift apart: probes the
// UTXO tracker and returns its reachability / sync state. Fields:
// tracker_reachable (bool), tracker_synced (bool), tracker_lag (number|null),
// tracker_halted (bool), tracker_mempool_ready (bool), maintenance (object|null).
//
// maintenance is the operator's DECLARED scheduled-outage window (see
// src/server/maintenance_window.js), carried alongside the readiness fields and never
// folded into them: it cannot make an unready encoder read ready, and it does
// not move the 503. A planned tracker stop and a broken tracker are the same
// readiness verdict - the difference is only that somebody meant one of them,
// which is exactly the distinction the public board had no way to draw.
//
// tracker_synced is SERVE-readiness, not the tracker's raw verdict: it
// applies the same maxUtxoTrackerLagBlocks ceiling create_tx enforces
// (deliberately tighter than the tracker's own SYNCED_THRESHOLD, money
// safety). Without the extra gate a 3-block lag read synced:true here while
// create_tx refused UTXO_TRACKER_STALE, so the status board painted Online
// on an un-serveable encoder. Null lag fails open, exactly like
// create_tx's overLag gate.
//
// A halted tracker (stopped polling on an unrecoverable reorg) and a negative
// lag (its committed tip sits above the node's, so its outputs are orphaned)
// are both un-serveable regardless of what `synced` says, and both were painting
// Online here because only the upper lag bound was checked. A tracker whose
// mempool has not reconverged is un-serveable for the same reason: create_tx
// refuses it UTXO_TRACKER_NOT_READY, so leaving it out of this probe recreated
// the same board-versus-encoder divergence the probe exists to prevent.
//
// node_tier_mismatch / node_tier_checked: the probe runs the same coin-node tier
// check the money methods refuse a wrong-network node with, instead of reading a
// flag only an earlier money call could have set. Only a confirmed mismatch is
// unready; an unchecked tier (node unreachable, or slower than the deadline above)
// stays fail-open exactly as the money methods are, and reads node_tier_checked:false.
//
// readMaintenanceWindow is passed in by the caller, which binds it when its own
// module loads, so a test that stubs it around that load still reaches the stub.
function createServeReadiness({ encoder, readMaintenanceWindow }) {
// Run the connector's tier check under the deadline and report what it settled.
async function probeNodeTier() {
    const connector = encoder.connector
    if (connector && typeof connector.assertNodeTier === 'function') {
        let timer
        const deadline = new Promise(resolve => { timer = setTimeout(resolve, NODE_TIER_PROBE_DEADLINE_MS) })
        // Swallow every outcome: a mismatch is read back from the connector below,
        // and a late rejection after the deadline must not surface as unhandled.
        const check = Promise.resolve().then(() => connector.assertNodeTier()).catch(() => {})
        try {
            await Promise.race([check, deadline])
        } finally {
            clearTimeout(timer)
        }
    }
    const node_tier_mismatch = (connector && connector.nodeTierMismatch) || null
    const node_tier_checked = Boolean(node_tier_mismatch) || Boolean(connector && connector.nodeTierOk === true)
    return { node_tier_mismatch, node_tier_checked }
}

// Probe the tracker and the node tier together and return the readiness fields above.
async function getServeReadiness() {
    // Start the node-tier check beside the tracker probe, so the probe waits for the slower of the two, not their sum.
    const nodeTier = probeNodeTier()
    // Read first and independently of the tracker probe: the window is what
    // explains a tracker that is deliberately down, so it must survive the
    // catch below rather than depend on the probe it annotates.
    const maintenance = await readMaintenanceWindow()
    let tracker_reachable = false
    let tracker_synced = false
    let tracker_lag = null
    let tracker_halted = false
    let tracker_mempool_ready = false
    try {
        const status = await encoder.utxoTrackerConnector.getSyncStatus()
        tracker_reachable = true
        // This probe applies the SAME freshness classifier create_tx refuses a
        // tracker with, against this endpoint's payload, so the board and the
        // encoder cannot drift apart: both read getSyncStatus() through
        // classifyTrackerFreshness instead of each re-deriving over-lag,
        // behind-node, halted and mempool-ready. The remaining asymmetry is
        // intentional: readiness needs the tracker's POSITIVE synced assertion
        // (syncedClaimed), while the create_tx gate refuses only on negatives.
        const freshness = XChainEncoder.classifyTrackerFreshness(status, encoder.maxUtxoTrackerLagBlocks)
        tracker_halted = freshness.halted
        tracker_mempool_ready = freshness.mempoolReady
        tracker_synced = freshness.syncedClaimed && freshness.code === null
        tracker_lag = freshness.lag
    } catch (_err) {
        // tracker unreachable; fields stay at defaults
    }
    const { node_tier_mismatch, node_tier_checked } = await nodeTier
    return { tracker_reachable, tracker_synced, tracker_lag, tracker_halted, tracker_mempool_ready, node_tier_mismatch, node_tier_checked, maintenance }
}

return getServeReadiness
}

module.exports = { createServeReadiness }
