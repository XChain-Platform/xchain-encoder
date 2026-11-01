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

const { classifyTrackerFreshness } = require('../XChainEncoder/request_resolution.js')
const { classifyRemoteSync } = require('../XChainEncoder/trackerless_profile.js')
const config = require('../common/config.js')

// Cap the tier check well under NODE_RPC_TIMEOUT: a failed chain read is not
// cached, so an unreachable node would otherwise hold every probe for 30s.
const NODE_TIER_PROBE_DEADLINE_MS = 3000

// How long one tracker sync-status read serves every probe (about 30 reads a
// minute at most, far under the tracker's per-IP budget).
const TRACKER_PROBE_TTL_MS = 2000

// The unit suites share one module-level probe and swap the tracker stub between
// calls, so their mocha setup sets ENCODER_TRACKER_PROBE_TTL_MS to 0 and every
// probe reads the tracker.
function trackerProbeTtlMs() {
    const raw = config.ENCODER_TRACKER_PROBE_TTL_MS
    const ms = raw === undefined || raw === '' ? NaN : Number(raw)
    return Number.isFinite(ms) && ms >= 0 ? ms : TRACKER_PROBE_TTL_MS
}

// Run the connector's tier check under the deadline and report what it settled.
async function probeNodeTier(connector) {
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

// Map one tracker sync-status answer onto the tracker_* readiness fields. Uses
// the same profile-aware refusal create_tx applies: the default profile stays
// fail-open for legacy trackers, while remote requires an attested numeric lag
// and a positive synced assertion.
function classifyTracker(encoder, status) {
    const freshness = classifyTrackerFreshness(status, encoder.maxUtxoTrackerLagBlocks)
    const refusal = classifyRemoteSync(encoder.trackerProfile, status, encoder.maxUtxoTrackerLagBlocks)
    return {
        tracker_reachable: true,
        tracker_synced: freshness.syncedClaimed && refusal === null,
        tracker_lag: freshness.lag,
        tracker_halted: freshness.halted,
        tracker_mempool_ready: freshness.mempoolReady
    }
}

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
// create_tx's default-profile gate. The remote profile additionally requires
// a numeric lag and a positive synced assertion.
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
//
// The tracker read is shared across probes: one call serves every probe inside
// TRACKER_PROBE_TTL_MS, and probes arriving while it is in flight join it. The
// tracker rate-limits per caller IP and the encoder's readiness polls, docker
// healthcheck and create_tx reads share that bucket, so an uncached probe per
// request let probe traffic burn the budget and make a healthy encoder unready.
// A failure is cached for the same window, so a rate-limited tracker is asked
// once per window rather than once per probe. `now` is injectable for tests.
function createServeReadiness({ encoder, readMaintenanceWindow, now = Date.now, trackerTtlMs = trackerProbeTtlMs() }) {
let trackerRead = null // { at, promise }
function readTrackerStatus() {
    const t = now()
    if (trackerRead && t - trackerRead.at >= 0 && t - trackerRead.at < trackerTtlMs) return trackerRead.promise
    const promise = Promise.resolve()
        .then(() => encoder.utxoTrackerConnector.getSyncStatus())
        .then(status => ({ ok: true, status }), error => ({ ok: false, error }))
    trackerRead = { at: t, promise }
    return promise
}

// Probe the tracker and the node tier together and return the readiness fields above.
async function getServeReadiness() {
    // Start the node-tier check beside the tracker probe, so the probe waits for the slower of the two, not their sum.
    const nodeTier = probeNodeTier(encoder.connector)
    // Read first and independently of the tracker probe: the window is what
    // explains a tracker that is deliberately down, so it must survive the
    // catch below rather than depend on the probe it annotates.
    const maintenance = await readMaintenanceWindow()
    let tracker = { tracker_reachable: false, tracker_synced: false, tracker_lag: null, tracker_halted: false, tracker_mempool_ready: false }
    const read = await readTrackerStatus()
    // An unreachable tracker leaves the fields at their defaults.
    if (read.ok) tracker = classifyTracker(encoder, read.status)
    const { node_tier_mismatch, node_tier_checked } = await nodeTier
    return { ...tracker, node_tier_mismatch, node_tier_checked, maintenance }
}

return getServeReadiness
}

module.exports = { createServeReadiness, TRACKER_PROBE_TTL_MS }
