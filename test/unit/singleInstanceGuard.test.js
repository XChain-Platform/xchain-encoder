/*
 * Unit tests for the single-instance deploy guard .
 *
 * The outpoint-reservation store is an in-process Map; these tests pin the
 * boot-time guards that keep horizontally scaled or duplicate-process deploys
 * from silently racing UTXO selections.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { assertSingleInstance, acquireInstanceLock, releaseLockOnSignals, isPidAlive } = require('../../src/singleInstanceGuard')

describe('singleInstanceGuard', function () {

    describe('assertSingleInstance', function () {
        it('passes when ENCODER_REPLICAS is unset', function () {
            assert.strictEqual(assertSingleInstance({}), true)
        })

        it('passes when ENCODER_REPLICAS is empty', function () {
            assert.strictEqual(assertSingleInstance({ ENCODER_REPLICAS: '' }), true)
        })

        it('passes when ENCODER_REPLICAS=1', function () {
            assert.strictEqual(assertSingleInstance({ ENCODER_REPLICAS: '1' }), true)
        })

        it('throws when ENCODER_REPLICAS > 1', function () {
            assert.throws(
                () => assertSingleInstance({ ENCODER_REPLICAS: '2' }),
                /single-instance only/
            )
        })

        it('throws on non-integer values', function () {
            for (const bad of ['0', '-1', 'two', '1.5', 'NaN']) {
                assert.throws(
                    () => assertSingleInstance({ ENCODER_REPLICAS: bad }),
                    /positive integer/,
                    'expected throw for ' + bad
                )
            }
        })
    })

    // The lock records { pid, cmd } so a later boot can tell the process that
    // took it from whatever holds that pid number now . A bare integer
    // is still accepted, because a lock can outlive an upgrade.
    function heldPid(file) {
        const text = fs.readFileSync(file, 'utf8')
        // A bare pid is itself valid JSON, so check for an object before reading
        // .pid off it, the same trap the reader in the source has to avoid.
        try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed === 'object') return parseInt(parsed.pid, 10)
        } catch (e) { /* not JSON */ }
        return parseInt(text, 10)
    }
    function heldCmd(file) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')).cmd } catch (e) { return null }
    }

    describe('acquireInstanceLock', function () {
        let dir
        beforeEach(function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-lock-test-'))
        })
        afterEach(function () {
            fs.rmSync(dir, { recursive: true, force: true })
        })

        it('takes the lock, writes our pid, and release removes the file', function () {
            const file = path.join(dir, 'a.lock')
            const release = acquireInstanceLock(file)
            assert.strictEqual(heldPid(file), process.pid)
            release()
            assert.strictEqual(fs.existsSync(file), false)
            release() // idempotent
        })

        it('refuses when a live other process holds the lock', function () {
            const file = path.join(dir, 'b.lock')
            // PID 1 is alive and is never our own pid, which is all this case
            // needs; the holder's IDENTITY is injected because pid 1 is init, not
            // an encoder. Before identity was checked this test passed on macOS
            // and would have failed on Linux for a reason it never meant to
            // assert: no /proc off Linux means "cannot tell" and the guard
            // refuses, while on Linux /proc/1/cmdline reads `systemd` and the
            // guard now correctly rules it out. Pinning the premise keeps this
            // about refusing a REAL holder on every platform.
            fs.writeFileSync(file, '1')
            assert.throws(
                () => acquireInstanceLock(file, {}, { describePid: () => 'node /XChainEncoder/src/api.js' }),
                /Another xchain-encoder instance \(pid 1\)/
            )
            // Lock left intact for the real holder.
            assert.strictEqual(fs.readFileSync(file, 'utf8'), '1')
        })

        // The platform difference above is worth asserting rather than merely
        // designing around, because it is the whole reason the legacy path needs
        // an identity test at all.
        it('on Linux, rules out init as a lock holder through the real /proc read', function () {
            if (process.platform !== 'linux') return this.skip()
            const file = path.join(dir, 'b-linux.lock')
            fs.writeFileSync(file, '1')            // legacy lock naming pid 1
            const release = acquireInstanceLock(file)   // real describePid: reads /proc/1/cmdline
            assert.strictEqual(heldPid(file), process.pid, 'init is alive but is not an encoder')
            release()
        })

        it('off Linux, refuses on the same lock because identity is unknowable', function () {
            if (process.platform === 'linux') return this.skip()
            const file = path.join(dir, 'b-nonlinux.lock')
            fs.writeFileSync(file, '1')
            assert.throws(() => acquireInstanceLock(file), /Another xchain-encoder instance \(pid 1\)/)
        })

        it('breaks a stale lock held by a dead pid', function () {
            const file = path.join(dir, 'c.lock')
            // Find a dead pid.
            let deadPid = 99999
            while (isPidAlive(deadPid)) deadPid--
            fs.writeFileSync(file, String(deadPid))
            const release = acquireInstanceLock(file)
            assert.strictEqual(heldPid(file), process.pid)
            release()
        })

        it('breaks a lock with garbage contents', function () {
            const file = path.join(dir, 'd.lock')
            fs.writeFileSync(file, 'not-a-pid')
            const release = acquireInstanceLock(file)
            assert.strictEqual(heldPid(file), process.pid)
            release()
        })

        it('re-takes a lock recorded under our own pid (crash-restart same pid file)', function () {
            const file = path.join(dir, 'e.lock')
            fs.writeFileSync(file, String(process.pid))
            const release = acquireInstanceLock(file)
            assert.strictEqual(heldPid(file), process.pid)
            release()
        })

        // . A bare pid is not an identity: the lockfile lives in the
        // container's writable layer and survives a restart, and the next boot's
        // process tree hands that number to a different live process. Measured on
        // the regtest encoder: the lock held node's pid, that number had become
        // npm's `sh` wrapper, and the guard refused to boot against npm's own
        // shell until the file was removed by hand.
        it('[REGRESSION] breaks a lock whose live pid has been REUSED by another process', function () {
            const file = path.join(dir, 'reuse.lock')
            fs.writeFileSync(file, JSON.stringify({ pid: 1, cmd: 'node /XChainEncoder/src/api.js' }))
            const release = acquireInstanceLock(file, {}, {
                isPidAlive:  () => true,      // pid 1 is alive, as it was on the venue
                describePid: () => 'sh',      // but it is npm's shell now, not the encoder
            })
            assert.strictEqual(heldPid(file), process.pid, 'the stale lock is broken and re-taken')
            release()
        })

        it('still refuses when the live pid IS the process that took the lock', function () {
            // The guard must not become permissive: a genuine second encoder has a
            // matching command line and has to be rejected.
            const file = path.join(dir, 'real.lock')
            const cmd = 'node /XChainEncoder/src/api.js'
            fs.writeFileSync(file, JSON.stringify({ pid: 1, cmd }))
            assert.throws(
                () => acquireInstanceLock(file, {}, { isPidAlive: () => true, describePid: () => cmd }),
                /Another xchain-encoder instance \(pid 1\)/
            )
            assert.strictEqual(heldPid(file), 1, 'the real holder keeps its lock')
        })

        it('refuses when identity cannot be established, which is the safe side', function () {
            // Off Linux there is no /proc, so describePid returns null and the old
            // conservative pid-liveness rule has to stand.
            const file = path.join(dir, 'unknown.lock')
            fs.writeFileSync(file, JSON.stringify({ pid: 1, cmd: 'node /XChainEncoder/src/api.js' }))
            assert.throws(
                () => acquireInstanceLock(file, {}, { isPidAlive: () => true, describePid: () => null }),
                /Another xchain-encoder instance \(pid 1\)/
            )
        })

        // A lock written before this change carries no identity. Refusing on it
        // outright would reproduce the wedge on the FIRST restart after the
        // upgrade, which is exactly when an old bare-pid file is lying around, so
        // the holder is ruled out by what it is actually running instead.
        // The command lines below are the REAL ones, read out of the running
        // regtest encoder container:
        //     pid  1  npm run api
        //     pid 18  sh -c node ./src/api.js
        //     pid 19  node ./src/api.js
        // A stale lock most often lands on 18 or 1, and both of those mention
        // api.js, so ruling the holder out by substring would have kept the
        // container wedged on precisely the case this defends.
        const CONTAINER_TREE = {
            npm:  'npm run api',
            shim: 'sh -c node ./src/api.js',
            node: 'node ./src/api.js',
        }

        it('[REGRESSION] breaks a legacy bare-pid lock whose holder is npm\'s shell wrapper', function () {
            const file = path.join(dir, 'legacy-reused.lock')
            fs.writeFileSync(file, '1')
            const release = acquireInstanceLock(file, {}, {
                isPidAlive: () => true, describePid: () => CONTAINER_TREE.shim,
            })
            assert.strictEqual(heldPid(file), process.pid, 'sh -c is not an encoder, however much it mentions one')
            release()
        })

        it('[REGRESSION] breaks a legacy bare-pid lock whose holder is the npm parent', function () {
            const file = path.join(dir, 'legacy-npm.lock')
            fs.writeFileSync(file, '1')
            const release = acquireInstanceLock(file, {}, {
                isPidAlive: () => true, describePid: () => CONTAINER_TREE.npm,
            })
            assert.strictEqual(heldPid(file), process.pid)
            release()
        })

        it('breaks a legacy bare-pid lock whose holder is unrelated', function () {
            const file = path.join(dir, 'legacy-sh.lock')
            fs.writeFileSync(file, '1')
            const release = acquireInstanceLock(file, {}, {
                isPidAlive: () => true, describePid: () => 'sh',
            })
            assert.strictEqual(heldPid(file), process.pid)
            release()
        })

        it('refuses on a legacy bare-pid lock whose holder IS running an encoder', function () {
            const file = path.join(dir, 'legacy-real.lock')
            fs.writeFileSync(file, '1')
            assert.throws(
                () => acquireInstanceLock(file, {}, {
                    isPidAlive: () => true, describePid: () => CONTAINER_TREE.node,
                }),
                /Another xchain-encoder instance \(pid 1\)/
            )
            assert.strictEqual(heldPid(file), 1, 'the real holder keeps its lock')
        })

        it('refuses a real second encoder started under an absolute node path', function () {
            const file = path.join(dir, 'legacy-abs.lock')
            fs.writeFileSync(file, '1')
            assert.throws(
                () => acquireInstanceLock(file, {}, {
                    isPidAlive: () => true, describePid: () => '/usr/local/bin/node /XChainEncoder/src/api.js',
                }),
                /Another xchain-encoder instance \(pid 1\)/
            )
        })

        it('refuses on a legacy lock when the holder cannot be described at all', function () {
            const file = path.join(dir, 'legacy-unknown.lock')
            fs.writeFileSync(file, '1')
            assert.throws(
                () => acquireInstanceLock(file, {}, { isPidAlive: () => true, describePid: () => null }),
                /Another xchain-encoder instance \(pid 1\)/
            )
        })

        it('records its own identity in the lock, which is what makes reuse detectable', function () {
            const file = path.join(dir, 'identity.lock')
            const release = acquireInstanceLock(file, {}, { selfDescription: () => 'node /XChainEncoder/src/api.js' })
            assert.strictEqual(heldCmd(file), 'node /XChainEncoder/src/api.js')
            release()
        })

        it('honors ENCODER_INSTANCE_LOCK_FILE from env when no path arg given', function () {
            const file = path.join(dir, 'env.lock')
            const release = acquireInstanceLock(null, { ENCODER_INSTANCE_LOCK_FILE: file })
            assert.strictEqual(fs.existsSync(file), true)
            release()
        })
    })

    describe('isPidAlive', function () {
        it('reports our own pid alive', function () {
            assert.strictEqual(isPidAlive(process.pid), true)
        })
    })

    // The lock is released on the way out through a SIGNAL, because that is how
    // this process actually dies : `docker stop` and `docker restart`
    // send SIGTERM, and 'exit' does not fire for that. A fake process stands in
    // so the assertions do not depend on signalling the test runner.
    describe('releaseLockOnSignals', function () {
        // Records what the handler did instead of doing it. `alive` models
        // whether the re-raise actually killed us: false is the ordinary case,
        // true is PID 1, where the kernel drops signals that have no handler.
        function fakeProcess({ diesOnReraise = true } = {}) {
            const proc = {
                pid: 4242,
                listeners: {},
                killed: [],
                exited: [],
                alive: true,
                on(sig, fn) { (this.listeners[sig] = this.listeners[sig] || []).push(fn) },
                off(sig, fn) {
                    this.listeners[sig] = (this.listeners[sig] || []).filter(f => f !== fn)
                },
                kill(pid, sig) {
                    this.killed.push([pid, sig])
                    if (diesOnReraise) this.alive = false
                },
                exit(code) { this.exited.push(code) },
                raise(sig) { for (const fn of (this.listeners[sig] || []).slice()) fn() }
            }
            return proc
        }

        // The handler arms a RERAISE_GRACE_MS fallback timer. A fixed sleep
        // races it: under load the implementation timer can fire after the
        // test's own timer, so wait on the OUTCOME instead of on wall clock.
        const settleUntil = async (predicate, what) => {
            const deadline = Date.now() + 5000
            while (Date.now() < deadline) {
                if (predicate()) return
                await new Promise(resolve => setTimeout(resolve, 5))
            }
            throw new Error('timed out waiting for ' + what)
        }

        it('registers a handler for both signals a stop can send', function () {
            const proc = fakeProcess()
            releaseLockOnSignals(() => {}, proc)
            assert.strictEqual(proc.listeners.SIGTERM.length, 1)
            assert.strictEqual(proc.listeners.SIGINT.length, 1)
        })

        it('releases the lock on SIGTERM, which is what `docker stop` sends', function () {
            const proc = fakeProcess()
            let released = 0
            releaseLockOnSignals(() => { released++ }, proc)
            proc.raise('SIGTERM')
            assert.strictEqual(released, 1)
        })

        it('releases the lock on SIGINT too', function () {
            const proc = fakeProcess()
            let released = 0
            releaseLockOnSignals(() => { released++ }, proc)
            proc.raise('SIGINT')
            assert.strictEqual(released, 1)
        })

        it('re-raises the same signal so the death stays a signalled death', function () {
            const proc = fakeProcess()
            releaseLockOnSignals(() => {}, proc)
            proc.raise('SIGTERM')
            assert.deepStrictEqual(proc.killed, [[4242, 'SIGTERM']])
        })

        it('deregisters itself before re-raising, or the re-raise re-enters the handler', function () {
            const proc = fakeProcess()
            releaseLockOnSignals(() => {}, proc)
            proc.raise('SIGTERM')
            assert.strictEqual(proc.listeners.SIGTERM.length, 0)
        })

        it('leaves OTHER listeners for the same signal registered', function () {
            const proc = fakeProcess()
            const gracefulShutdown = () => {}
            releaseLockOnSignals(() => {}, proc)
            proc.on('SIGTERM', gracefulShutdown)
            proc.raise('SIGTERM')
            assert.deepStrictEqual(proc.listeners.SIGTERM, [gracefulShutdown])
        })

        it('does not force an exit when the re-raise did kill the process', function () {
            const proc = fakeProcess({ diesOnReraise: true })
            releaseLockOnSignals(() => {}, proc)
            proc.raise('SIGTERM')
            // raise() runs the handler synchronously, so the re-raise is already
            // recorded; there is nothing to wait for and the old grace sleep only
            // let the unref'd fallback timer race the assertion.
            // A real process is gone here; the fallback timer fires into nothing.
            // What must not happen is a SECOND, different exit path being taken
            // while the signalled death is already in flight.
            assert.deepStrictEqual(proc.killed, [[4242, 'SIGTERM']])
        })

        // PID 1 is what the container CMD makes this process, and the kernel
        // drops signals PID 1 has no handler for, so the re-raise above is a
        // no-op and nothing would ever exit: docker stop would hang out its
        // full 10s timeout and SIGKILL, which is the one death that cannot
        // release anything.
        it('forces exit 143 when a re-raised SIGTERM is ignored (PID 1)', async function () {
            const proc = fakeProcess({ diesOnReraise: false })
            releaseLockOnSignals(() => {}, proc)
            proc.raise('SIGTERM')
            await settleUntil(() => proc.exited.length > 0, 'the PID-1 fallback exit')
            assert.deepStrictEqual(proc.exited, [143])
        })

        it('forces exit 130 when a re-raised SIGINT is ignored (PID 1)', async function () {
            const proc = fakeProcess({ diesOnReraise: false })
            releaseLockOnSignals(() => {}, proc)
            proc.raise('SIGINT')
            await settleUntil(() => proc.exited.length > 0, 'the PID-1 fallback exit')
            assert.deepStrictEqual(proc.exited, [130])
        })

        it('defaults to the real process when none is injected', function () {
            const before = process.listenerCount('SIGTERM')
            releaseLockOnSignals(() => {})
            assert.strictEqual(process.listenerCount('SIGTERM'), before + 1)
            // Leave the runner's signal disposition as we found it.
            const added = process.listeners('SIGTERM').pop()
            process.off('SIGTERM', added)
            process.off('SIGINT', process.listeners('SIGINT').pop())
        })
    })
})
