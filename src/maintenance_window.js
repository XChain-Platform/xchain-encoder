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
 * XChain Encoder - scheduled-maintenance window
 *
 * A PLANNED outage reads exactly like a fault on the public board: the
 * monthly tracker-bootstrap publish takes the UTXO tracker down, /status
 * answers 503 with tracker_reachable:false, and encoder.xchain.io paints
 * the row Degraded for the length of the run (2026-08-01: 3h36m on BTC).
 * The probe is telling the truth and must not be silenced - what was
 * missing is the operator's side of the story, so the board can say
 * "this outage is on purpose" instead of "this encoder is broken".
 *
 * The operator declares a window by dropping a small JSON sentinel where
 * ENCODER_MAINTENANCE_FILE points (xchain-node's BootstrapService writes
 * and removes it around the tracker stop). This module reads it, and the
 * readiness probe carries the result alongside the UNCHANGED readiness
 * booleans: nothing here can make an unready encoder read ready, flip the
 * 503, or alter tracker_reachable / tracker_synced. It only adds context.
 *
 * The sentinel is deliberately fail-safe in the honest direction. Every
 * way it can be wrong - missing, unreadable, oversized, unparseable, no
 * expiry, expired, a timestamp no Date can represent, or claiming a window
 * longer than MAX_WINDOW_MS either in time remaining or in declared span -
 * resolves to "no maintenance", which puts the row back on Degraded. A
 * publish that crashes without cleaning up therefore stops excusing the
 * outage at its own declared end time rather than hiding it forever.
 *
 ********************************************************************/

const fs = require('fs')

// Inside the encoder container, so xchain-node can write it with a plain
// `docker exec tee` against an already-running encoder: no bind mount, and
// therefore no container recreate, to start reporting maintenance. Living on
// the container's own filesystem also means a restart clears it, which is the
// safe direction (the row goes back to reporting the raw fault).
const DEFAULT_SENTINEL = '/tmp/xchain-encoder-maintenance.json'

// A sentinel is a handful of fields. Anything larger is not one, and refusing
// it by size keeps a runaway file from being parsed at all.
const MAX_SENTINEL_BYTES = 4096

// Operator-authored, and /status is public, so it is bounded and stripped to
// printable ASCII before it leaves the process.
const MAX_REASON_CHARS = 120

// The longest window that still reads as "scheduled". The slowest publish on
// record is under 4h; past a day an outage is an incident whatever the sentinel
// says, and an unbounded `until` would let one stale file paint a dead encoder
// green-adjacent forever.
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000

function sentinelPath() {
    return process.env.ENCODER_MAINTENANCE_FILE || DEFAULT_SENTINEL
}

// The largest absolute time value a JS Date can hold. A finite number past it
// is not a timestamp: new Date(v).toISOString() raises RangeError on it, which
// would break the readiness probe from inside the module whose whole job is
// making a wrong sentinel harmless.
const MAX_EPOCH_MS = 8.64e15

// Accepts an ISO-8601 string or epoch milliseconds; returns null for anything
// else, including the NaN a malformed date parses to and a finite number
// outside the representable Date range.
function toEpochMs(value) {
    if (typeof value === 'number') {
        return (Number.isFinite(value) && Math.abs(value) <= MAX_EPOCH_MS) ? value : null
    }
    if (typeof value !== 'string') return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

function cleanReason(value) {
    if (typeof value !== 'string') return ''
    // Printable ASCII only: the field is echoed in a public JSON body, and a
    // control character or a stray newline there is nobody's maintenance note.
    return value.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, MAX_REASON_CHARS)
}

// Turn raw sentinel text into the window /status publishes, or null when the
// file does not describe an ACTIVE, bounded, currently-open window.
function parseMaintenanceWindow(text, now = Date.now()) {
    // The ceiling is named in BYTES, so it is measured in bytes: String.length
    // counts UTF-16 code units, which a multibyte reason undercounts by up to
    // 3x against the limit it is being compared to.
    if (typeof text !== 'string' || text.length === 0) return null
    if (Buffer.byteLength(text, 'utf8') > MAX_SENTINEL_BYTES) return null

    let doc
    try { doc = JSON.parse(text) } catch { return null }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null

    // An expiry is REQUIRED. Without one a publish that dies mid-run leaves the
    // board excusing a genuine outage with no end date, which is worse than the
    // Degraded label this exists to replace.
    const until = toEpochMs(doc.until)
    if (until === null || until <= now) return null
    if (until - now > MAX_WINDOW_MS) return null

    // `since` is optional, but a SUPPLIED one that does not read as a timestamp
    // is a wrong sentinel, not an absent start: silently demoting it to null
    // would let a typo buy the unbounded-span treatment below.
    const sinceSupplied = doc.since !== undefined && doc.since !== null
    const since = toEpochMs(doc.since)
    if (sinceSupplied && since === null) return null

    // A window may be declared ahead of time; it is not active until it opens.
    if (since !== null && since > now) return null

    // The ceiling above bounds only the time REMAINING, which a stale overlong
    // declaration grows into: a 30-day window is refused for 29 days and then
    // starts excusing a genuine outage through its final 24 hours. When the
    // operator declared a start, the declared span is bounded too, so the same
    // sentinel can never go from refused to active as its expiry nears.
    if (since !== null && until - since > MAX_WINDOW_MS) return null

    return {
        active: true,
        reason: cleanReason(doc.reason),
        since: since === null ? null : new Date(since).toISOString(),
        until: new Date(until).toISOString()
    }
}

// Reads the sentinel. Never throws and never rejects: a readiness probe that
// fails because a maintenance note is unreadable would be a strictly worse
// probe than the one that predates this file.
async function readMaintenanceWindow(now = Date.now(), filePath = sentinelPath()) {
    let bytes
    try {
        bytes = await readBounded(filePath, MAX_SENTINEL_BYTES + 1)
    } catch {
        return null   // absent (the normal case) or unreadable
    }
    // One byte past the ceiling is enough to know the file is too big to be a
    // sentinel, and it is refused before it is decoded or parsed.
    if (bytes.length > MAX_SENTINEL_BYTES) return null
    // Defence in depth for the promise in this comment: a formatting bug in the
    // parser must degrade to "no maintenance", not take the probe down with it.
    try {
        return parseMaintenanceWindow(bytes.toString('utf8'), now)
    } catch {
        return null
    }
}

// At most `limit` bytes, so a runaway file is refused by size instead of being
// materialized on every readiness probe. Reads in a loop because a single
// read() may come back short, and closes the handle on every path.
async function readBounded(filePath, limit) {
    const handle = await fs.promises.open(filePath, 'r')
    try {
        const buf = Buffer.alloc(limit)
        let filled = 0
        while (filled < limit) {
            const { bytesRead } = await handle.read(buf, filled, limit - filled, filled)
            if (bytesRead === 0) break
            filled += bytesRead
        }
        return buf.subarray(0, filled)
    } finally {
        await handle.close().catch(() => {})
    }
}

module.exports = {
    readMaintenanceWindow,
    parseMaintenanceWindow,
    sentinelPath,
    DEFAULT_SENTINEL,
    MAX_SENTINEL_BYTES,
    MAX_REASON_CHARS,
    MAX_WINDOW_MS
}
