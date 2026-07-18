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
 * XChain Encoder - Single-instance deploy guard
 *
 * The encoder's UTXO outpoint-reservation store (XChainEncoder.js
 * `outpointReservations`) and the express-rate-limit MemoryStore are both
 * in-process. Running more than one encoder replica behind one endpoint
 * silently defeats both: two replicas can each build a PSBT spending the
 * same tracker-fetched UTXO (one tx is rejected at broadcast and the
 * signer's fee work is wasted), and per-IP rate limits multiply by the
 * replica count. Until a shared (e.g. Redis-backed) reservation store
 * exists, single-instance is a HARD deploy constraint; this module makes
 * the constraint fail loudly at boot instead of failing silently at
 * broadcast time.
 *
 ********************************************************************/

const fs = require('fs')
const os = require('os')
const path = require('path')

// Refuses boot when the operator declares a horizontally scaled deploy.
// ENCODER_REPLICAS is a deploy-manifest declaration (set it next to the
// orchestrator's replica count); any value above 1 is rejected because no
// shared reservation store exists yet. Unset/empty means the default
// single-replica deploy and passes.
function assertSingleInstance(env = process.env) {
    const raw = env.ENCODER_REPLICAS
    if (raw === undefined || raw === '') return true
    const replicas = Number(raw)
    if (!Number.isInteger(replicas) || replicas < 1) {
        throw new Error('ENCODER_REPLICAS must be a positive integer, got: ' + raw)
    }
    if (replicas > 1) {
        throw new Error(
            'ENCODER_REPLICAS=' + replicas + ' is unsupported: the UTXO outpoint-reservation ' +
            'double-spend guard and the rate limiter are in-process (single-instance only). ' +
            'Horizontally scaling the encoder lets two replicas build PSBTs spending the same ' +
            'UTXO. Run exactly one replica per endpoint until a shared reservation store ' +
            '(e.g. Redis-backed) is implemented.'
        )
    }
    return true
}

// Same-host duplicate-process guard: takes an exclusive PID lockfile so two
// encoder processes accidentally started on one host (each with its own
// reservation Map) fail fast instead of racing UTXO selections. Stale locks
// (dead PID, or unreadable contents) are broken and re-taken. This cannot see
// replicas on OTHER hosts or in sibling containers; ENCODER_REPLICAS above is
// the cross-host declaration. Returns a release function.
function acquireInstanceLock(lockPath, env = process.env) {
    const file = lockPath ||
        env.ENCODER_INSTANCE_LOCK_FILE ||
        path.join(os.tmpdir(), 'xchain-encoder-' + (env.ENCODER_API_PORT || 'default') + '.lock')

    const tryTake = () => {
        const fd = fs.openSync(file, 'wx')
        fs.writeSync(fd, String(process.pid))
        fs.closeSync(fd)
    }

    try {
        tryTake()
    } catch (err) {
        if (err.code !== 'EEXIST') throw err
        const holderPid = parseInt(fs.readFileSync(file, 'utf8'), 10)
        if (Number.isInteger(holderPid) && holderPid > 0 && isPidAlive(holderPid) && holderPid !== process.pid) {
            throw new Error(
                'Another xchain-encoder instance (pid ' + holderPid + ') holds the instance lock ' +
                file + '. The outpoint-reservation store is in-process; running two encoder ' +
                'instances against one UTXO set risks conflicting double-spend PSBTs. Stop the ' +
                'other instance, or set ENCODER_INSTANCE_LOCK_FILE to isolate intentionally ' +
                'separate deployments.'
            )
        }
        // Stale (dead holder or garbage contents): break and re-take.
        fs.unlinkSync(file)
        tryTake()
    }

    let released = false
    return function release() {
        if (released) return
        released = true
        try { fs.unlinkSync(file) } catch (e) { /* already gone */ }
    }
}

// kill(pid, 0) probes existence without signaling; EPERM means it exists but
// is owned by another user, which still counts as alive.
function isPidAlive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        return err.code === 'EPERM'
    }
}

module.exports = { assertSingleInstance, acquireInstanceLock, isPidAlive }
