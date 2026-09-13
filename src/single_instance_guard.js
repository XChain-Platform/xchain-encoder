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
 * Three of the encoder's guards hold their whole state in-process: the UTXO
 * outpoint-reservation store (XChainEncoder.js `outpointReservations`), the
 * recent-build duplicate refusal behind it (`recentBuilds`, enforced in
 * `_refuseDuplicateBuild`), and the express-rate-limit MemoryStore. Running
 * more than one encoder replica behind one endpoint silently defeats all
 * three: two replicas can each build a PSBT spending the same tracker-fetched
 * UTXO (one tx is rejected at broadcast and the signer's fee work is wasted),
 * each replica keeps its own recent-build map so one byte-identical
 * transaction is built once per replica and journaled as two broadcast
 * successes, and per-IP rate limits multiply by the replica count. Until a
 * shared (e.g. Redis-backed) store exists for all three, single-instance is a
 * HARD deploy constraint; this module makes the constraint fail loudly at boot
 * instead of failing silently at broadcast time.
 *
 ********************************************************************/

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// Filesystems that cannot hard-link. The atomic publication below falls back to
// the older open-'wx'-then-write on exactly these and on nothing else, because
// swallowing an unrecognized errno would silently give up the atomicity the
// whole protocol rests on.
const NO_HARDLINK_CODES = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV'])

// How many times a contender re-reads a lock whose record is not yet legible,
// and the pause between passes. A half-written record means an owner is mid
// publication, NOT that the lock is stale: an empty file parses to pid NaN,
// which skips every liveness and identity check, so judging it stale unlinks
// the lock out from under the owner still writing it. The window is bounded so
// a genuinely corrupt lock is still recoverable.
const INITIALIZING_RECHECK_PASSES = 10
const INITIALIZING_RECHECK_MS = 10

// Break-and-retake passes. Two processes can judge one dead lock stale at the
// same moment; the loser's re-take throws EEXIST, and the retry loop absorbs it
// so it cannot escape acquireInstanceLock raw and kill boot with an opaque error
// in place of the guard's own conflict message.
const BREAK_PASSES = 5

// Synchronous pause. This is a boot path that runs before the event loop has
// any work on it, so there is nothing to yield to and no async seam to thread
// through the callers.
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Refuses boot when the operator declares a horizontally scaled deploy.
// ENCODER_REPLICAS is a deploy-manifest declaration (set it next to the
// orchestrator's replica count); any value above 1 is rejected because the
// reservation, recent-build and rate-limit stores are all still per-process.
// Unset/empty means the default single-replica deploy and passes.
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
            'double-spend guard, the recent-build duplicate refusal and the rate limiter are ' +
            'all in-process (single-instance only). Horizontally scaling the encoder lets two ' +
            'replicas build PSBTs spending the same UTXO, and lets one byte-identical ' +
            'transaction be built once per replica and journaled as two successes. Run exactly ' +
            'one replica per endpoint until a shared store (e.g. Redis-backed) is implemented.'
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
// reservation and recent-build Maps) fail fast instead of racing UTXO
// selections and rebuilding one transaction twice. Stale locks
// (dead PID, unreadable contents, or a REUSED pid, see below) are broken and
// re-taken. This cannot see replicas on OTHER hosts or in sibling containers;
// ENCODER_REPLICAS above is the cross-host declaration. Returns a release
// function.
//
// A bare pid is not an identity, so the lock records the holder's command line
// and re-checks it. The file lives in the container's writable layer and
// survives a restart, and the next boot hands that pid number to a different
// live process: measured on the regtest encoder, the lock held node's number
// after it had become npm's `sh` wrapper, so the guard reported a conflict
// against npm's own shell and the container crash-looped, with `docker exec`
// refused throughout because the container never finished starting.
//
// A live pid whose command line no longer matches what wrote the lock is a
// reused number rather than an encoder, so the lock is stale. Where identity
// cannot be established (non-Linux, or /proc unreadable) the conservative rule
// stands, because refusing to boot is the safe side of a genuine conflict.
// `deps` is injectable so the tests can drive both branches without spawning
// real processes.
function acquireInstanceLock(lockPath, env = process.env, deps = {}) {
    const alive    = deps.isPidAlive  || isPidAlive
    const describe = deps.describePid || describePid
    const self     = deps.selfDescription || selfDescription

    const file = lockPath ||
        env.ENCODER_INSTANCE_LOCK_FILE ||
        path.join(os.tmpdir(), 'xchain-encoder-' + (env.ENCODER_API_PORT || 'default') + '.lock')

    // This acquisition's ownership token. It is what release() and the break path
    // test against, so a lock that has changed hands since is left alone: the old
    // release unlinked by PATH, so the first owner out deleted whatever record
    // happened to sit at that name, including a successor's.
    const token = crypto.randomBytes(16).toString('hex')

    // Publish ownership ATOMICALLY: write the complete record to a sibling temp
    // file, then link it into place. link() either creates the name or throws
    // EEXIST, and it publishes the finished record in one step, so the lock name
    // is never observable as a zero-byte file that a contender reads as stale.
    // openSync('wx') + a separate write cannot promise that, and the window is
    // wide: self() reads /proc between the two.
    const tryTake = () => {
        const record = JSON.stringify({ pid: process.pid, cmd: self(), token })
        const tmp = file + '.' + process.pid + '.' + token.slice(0, 8) + '.tmp'
        let tmpWritten = false
        try {
            const fd = fs.openSync(tmp, 'wx')
            try { fs.writeSync(fd, record) } finally { fs.closeSync(fd) }
            tmpWritten = true
            fs.linkSync(tmp, file)
        } catch (err) {
            if (tmpWritten && NO_HARDLINK_CODES.has(err.code)) {
                // No hard links on this mount. Fall back to the original
                // non-atomic publication, which is why the reader below still
                // treats an illegible record as an initializing owner.
                const fd = fs.openSync(file, 'wx')
                try { fs.writeSync(fd, record) } finally { fs.closeSync(fd) }
                return
            }
            throw err
        } finally {
            if (tmpWritten) { try { fs.unlinkSync(tmp) } catch (e) { /* already gone */ } }
        }
    }

    // Accepts three shapes: the JSON written above, the tokenless JSON written by
    // encoders that predate the token, and the bare integer written by those that
    // predate the record (a lock can outlive an upgrade). `legible` separates "no
    // readable record yet" from "a record that names no usable pid".
    const readHolder = () => {
        let text
        try { text = fs.readFileSync(file, 'utf8') } catch (e) { return { pid: NaN, cmd: null, token: null, legible: false } }
        if (text.trim() === '') return { pid: NaN, cmd: null, token: null, legible: false }
        // NB: a bare pid is itself valid JSON ('1' parses to the number 1), so the
        // object check is what keeps a legacy lock on the legacy path instead of
        // reading it as a record with no pid and breaking a live holder's lock.
        try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed === 'object') {
                const pid = parseInt(parsed.pid, 10)
                return { pid, cmd: parsed.cmd || null, token: parsed.token || null, legible: Number.isInteger(pid) }
            }
        } catch (e) { /* not JSON at all: fall through to the bare-pid reading */ }
        const pid = parseInt(text, 10)
        return { pid, cmd: null, token: null, legible: Number.isInteger(pid) }
    }

    // Re-read an illegible lock a bounded number of times before judging it.
    // An owner publishing through the non-atomic fallback above is mid-write,
    // not dead, and breaking its lock is how two processes both came to hold one.
    const readHolderSettled = () => {
        let holder = readHolder()
        for (let pass = 0; !holder.legible && pass < INITIALIZING_RECHECK_PASSES; pass++) {
            sleepSync(INITIALIZING_RECHECK_MS)
            holder = readHolder()
        }
        return holder
    }

    for (let pass = 0; ; pass++) {
        try {
            tryTake()
            break
        } catch (err) {
            if (err.code !== 'EEXIST') throw err
            const holder = readHolderSettled()
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
                        file + '. The outpoint-reservation and recent-build stores are in-process; ' +
                        'running two encoder instances against one UTXO set risks conflicting ' +
                        'double-spend PSBTs, and lets one transaction be built twice and journaled ' +
                        'as two successes. Stop the other instance, or set ENCODER_INSTANCE_LOCK_FILE ' +
                        'to isolate intentionally separate deployments.'
                    )
                }
                console.warn('singleInstanceGuard: breaking a stale lock on ' + file + ': pid ' +
                    holderPid + ' is alive but is running "' + liveCmd + '", ' +
                    (holder.cmd === null
                        ? 'which is not an encoder (the lock predates identity recording)'
                        : 'not the "' + holder.cmd + '" that took the lock') +
                    '. This is pid reuse after an unclean shutdown, not a second instance.')
            }
            // Stale (dead holder, garbage contents, or a reused pid): break and
            // re-take. A second process can reach this same verdict on the same lock,
            // so the re-take is not guaranteed to win. Losing it is a normal outcome:
            // go round again and re-evaluate whoever now holds the lock, and only
            // when the passes run out does the conflict error below stand in place of
            // a raw EEXIST escaping this function and killing boot.
            try { fs.unlinkSync(file) } catch (e) { /* somebody else broke it first */ }
            if (pass >= BREAK_PASSES) {
                throw new Error(
                    'Another xchain-encoder instance keeps re-taking the instance lock ' + file +
                    ' faster than this one can. The outpoint-reservation and recent-build stores ' +
                    'are in-process; running two encoder instances against one UTXO set risks ' +
                    'conflicting double-spend PSBTs. Stop the other instance, or set ' +
                    'ENCODER_INSTANCE_LOCK_FILE to isolate intentionally separate deployments.'
                )
            }
        }
    }

    let released = false
    return function release() {
        if (released) return
        released = true
        // Unlink only OUR record. The lock may legitimately have changed hands
        // (an instance ruled stale on the pid-reuse path is still running and
        // still owns a release), and deleting by path alone is how one owner's
        // exit freed another owner's lock.
        try {
            if (readHolder().token === token) fs.unlinkSync(file)
        } catch (e) { /* already gone, or unreadable: leave it for the stale path */ }
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
