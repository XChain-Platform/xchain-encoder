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

// Whether a command line is the encoder ITSELF, as opposed to something that
// merely mentions it. Only consulted for LEGACY locks that carry no recorded
// identity, and only to rule a holder OUT.
//
// The substring test this replaced was wrong on the exact deployment it exists
// for. Measured inside the running container, the tree is:
//     pid  1  npm run api
//     pid 18  sh -c node ./src/api.js
//     pid 19  node ./src/api.js
// and a stale lock lands on pid 18 far more often than not. That shell wrapper
// CONTAINS "api.js", so a substring match calls npm's own `sh` an encoder and
// stays wedged. Require the entry point to be the process being executed: the
// first token is the program, so `sh -c node ...` and `npm run api` are both
// correctly ruled out while `node ./src/api.js` is not.
// @param {cmd}  string  command line of the live process holding the lock
function looksLikeEncoder(cmd) {
    const argv0 = String(cmd).trim().split(/\s+/)[0] || ''
    const program = argv0.split('/').pop()
    const isNode = /^node(js)?$/.test(program)
    return isNode && /(^|[\s/])api\.js(\s|$)/.test(cmd)
}

// Read a live process's command line, for deciding whether a pid found in a
// lockfile is still the process that wrote it. Linux only (every deployed
// encoder runs in a Linux container); anywhere else this returns null, meaning
// "cannot tell", and the caller keeps the conservative pid-liveness behaviour.
// /proc/<pid>/cmdline is NUL-separated with a trailing NUL.
// @param {pid}  integer  process id to describe
function describePid(pid) {
    try {
        const raw = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')
        const cmd = raw.replace(/\0+$/, '').split('\0').join(' ').trim()
        return cmd === '' ? null : cmd
    } catch (e) {
        return null   // not Linux, process gone, or /proc not readable
    }
}

// This process's own command line, recorded INTO the lock so a later boot can
// tell "the pid that wrote this" from "whatever holds that pid number now".
function selfDescription() {
    return describePid(process.pid) || [process.argv0].concat(process.argv.slice(1)).join(' ')
}

// Same-host duplicate-process guard: takes an exclusive PID lockfile so two
// encoder processes accidentally started on one host (each with its own
// reservation Map) fail fast instead of racing UTXO selections. Stale locks
// (dead PID, unreadable contents, or a REUSED pid, see below) are broken and
// re-taken. This cannot see replicas on OTHER hosts or in sibling containers;
// ENCODER_REPLICAS above is the cross-host declaration. Returns a release
// function.
//
// The lock used to hold a bare pid, and a bare pid is not an identity.
// The file lives in the container's writable layer, so it SURVIVES a restart,
// and the next boot's process tree hands that same pid number to a different
// live process: measured on the regtest encoder, the lock held node's pid while
// that number had become npm's `sh` wrapper. The guard then reported "another
// instance holds the lock" against npm's own shell and the container crash
// -looped indefinitely, with `docker exec` refused the whole time because the
// container never finished starting. So the holder's identity is recorded and
// re-checked: a live pid whose command line no longer matches what wrote the
// lock is a reused number, not an encoder, and the lock is stale. When identity
// cannot be established (non-Linux, or /proc unreadable) the old conservative
// rule stands, since refusing to boot is the safe side of a genuine conflict.
// `deps` is injectable so the tests can drive both branches without spawning
// real processes.
function acquireInstanceLock(lockPath, env = process.env, deps = {}) {
    const alive    = deps.isPidAlive  || isPidAlive
    const describe = deps.describePid || describePid
    const self     = deps.selfDescription || selfDescription

    const file = lockPath ||
        env.ENCODER_INSTANCE_LOCK_FILE ||
        path.join(os.tmpdir(), 'xchain-encoder-' + (env.ENCODER_API_PORT || 'default') + '.lock')

    const tryTake = () => {
        const fd = fs.openSync(file, 'wx')
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, cmd: self() }))
        fs.closeSync(fd)
    }

    // Accepts both shapes: the JSON written above, and the bare integer written
    // by encoders that predate this change (a lock can outlive an upgrade).
    const readHolder = () => {
        let text
        try { text = fs.readFileSync(file, 'utf8') } catch (e) { return { pid: NaN, cmd: null } }
        // NB: a bare pid is itself valid JSON ('1' parses to the number 1), so the
        // object check is what keeps a legacy lock on the legacy path instead of
        // reading it as a record with no pid and breaking a live holder's lock.
        try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed === 'object') {
                return { pid: parseInt(parsed.pid, 10), cmd: parsed.cmd || null }
            }
        } catch (e) { /* not JSON at all: fall through to the bare-pid reading */ }
        return { pid: parseInt(text, 10), cmd: null }
    }

    try {
        tryTake()
    } catch (err) {
        if (err.code !== 'EEXIST') throw err
        const holder = readHolder()
        const holderPid = holder.pid
        if (Number.isInteger(holderPid) && holderPid > 0 && alive(holderPid) && holderPid !== process.pid) {
            // Alive, and not us. Only a matching identity makes it a real conflict.
            const liveCmd = describe(holderPid)
            // Recorded identity: the strong test, an exact mismatch means reuse.
            let reused = holder.cmd !== null && liveCmd !== null && liveCmd !== holder.cmd
            // A lock written before this change carries no identity to compare, and
            // refusing on it would reproduce the very wedge this fixes on the first
            // restart after the upgrade (the lock outlives the process that wrote
            // it, so an old bare-pid file is exactly what a rolling deploy meets).
            // Weaker but sufficient test for that case: the holder cannot be an
            // encoder if its command line is not running one.
            if (!reused && holder.cmd === null && liveCmd !== null && !looksLikeEncoder(liveCmd)) {
                reused = true
            }
            if (!reused) {
                throw new Error(
                    'Another xchain-encoder instance (pid ' + holderPid + ') holds the instance lock ' +
                    file + '. The outpoint-reservation store is in-process; running two encoder ' +
                    'instances against one UTXO set risks conflicting double-spend PSBTs. Stop the ' +
                    'other instance, or set ENCODER_INSTANCE_LOCK_FILE to isolate intentionally ' +
                    'separate deployments.'
                )
            }
            console.warn('singleInstanceGuard: breaking a stale lock on ' + file + ': pid ' +
                holderPid + ' is alive but is running "' + liveCmd + '", ' +
                (holder.cmd === null
                    ? 'which is not an encoder (the lock predates identity recording)'
                    : 'not the "' + holder.cmd + '" that took the lock') +
                '. This is pid reuse after an unclean shutdown, not a second instance.')
        }
        // Stale (dead holder, garbage contents, or a reused pid): break and re-take.
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

// Exit status a shell (and Docker) reports for a death by each signal.
const SIGNAL_EXIT_STATUS = { SIGTERM: 143, SIGINT: 130 }

// How long to wait for the re-raise below to actually kill us before forcing
// the exit ourselves. Only the PID 1 case ever waits this long.
const RERAISE_GRACE_MS = 50

// Release the instance lock when the process is SIGNALLED, not only when it
// exits on its own. `process.on('exit')` never fires for a signalled death and
// a signal is exactly how this process normally dies: `docker stop` and
// `docker restart` send SIGTERM. Without this the lockfile outlives every
// restart, which is the precondition for the pid-reuse trap the
// acquire path above now also defends against.
// `proc` is injectable so the tests can drive this without signalling mocha.
function releaseLockOnSignals(release, proc = process) {
    for (const signal of Object.keys(SIGNAL_EXIT_STATUS)) {
        const onSignal = () => {
            release()
            // Deregister only THIS handler, never every listener for the signal:
            // a graceful-shutdown handler added later must still get to run.
            proc.off(signal, onSignal)
            // Re-raise so the process still dies OF the signal, leaving exit
            // status and supervision semantics exactly as they were.
            proc.kill(proc.pid, signal)
            // ...except as PID 1, which is what the container CMD makes this
            // process: the kernel drops signals PID 1 has installed no handler
            // for, so the re-raise above is silently a no-op there and the
            // process would sit until Docker's 10s SIGKILL. If we are still
            // alive a moment later, exit with the status that signal would have
            // produced, which is what the supervisor was going to record anyway.
            const timer = setTimeout(() => proc.exit(SIGNAL_EXIT_STATUS[signal]), RERAISE_GRACE_MS)
            if (typeof timer.unref === 'function') timer.unref()
        }
        proc.on(signal, onSignal)
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

module.exports = { assertSingleInstance, acquireInstanceLock, releaseLockOnSignals, isPidAlive, describePid }
