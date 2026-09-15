const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { acquireInstanceLock, isPidAlive } = require('../../../src/server/single_instance_guard')

// The lock records { pid, cmd } so a later boot can tell the process that
// took it from whatever holds that pid number now. A bare integer
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

let dir

function createLockDirectory() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-lock-test-'))
}

function removeLockDirectory() {
    fs.rmSync(dir, { recursive: true, force: true })
}

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

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

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
    })
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

        // Same list, second refusal: a same-host conflict is the other way an
        // operator meets the constraint, so it names the per-process stores too.
        it('names the in-process stores in the lock-conflict refusal', function () {
            const file = path.join(dir, 'b-stores.lock')
            fs.writeFileSync(file, '1')
            let message = ''
            try {
                acquireInstanceLock(file, {}, { describePid: () => 'node /XChainEncoder/src/api.js' })
            } catch (err) { message = err.message }
            for (const store of [/outpoint-reservation/, /recent-build/]) {
                assert.match(message, store, 'lock-conflict refusal must name ' + store)
            }
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
    })
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

        it('breaks a stale lock held by a dead pid', function () {
            const file = path.join(dir, 'c.lock')
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
    })
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

        // A bare pid is not an identity: the lockfile lives in the
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
    })
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

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
    })
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

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
    })
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

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
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

        // Publication is a single link() of a fully written record: finished, or not
        // at all. A zero-byte file observable at the lock path reads as pid NaN, which
        // fails the Number.isInteger test and so skips the ENTIRE liveness and identity
        // block, falling straight through to unlink-and-take: two processes then hold
        // the lock, and the first release deletes the other's record.
        it('never leaves a half-written record observable at the lock path', function () {
            const file = path.join(dir, 'atomic.lock')
            const observed = []
            // selfDescription runs INSIDE publication, which is exactly the window
            // the old protocol left open, so it doubles as the observation hook.
            const release = acquireInstanceLock(file, {}, {
                selfDescription: () => {
                    observed.push(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)
                    return 'node /XChainEncoder/src/api.js'
                }
            })
            assert.ok(observed.length > 0, 'the observation hook must have run inside publication')
            for (const sample of observed) {
                if (sample === null) continue          // the name does not exist yet: fine
                const parsed = JSON.parse(sample)      // throws on the zero-byte file
                assert.ok(Number.isInteger(parsed.pid), 'a published record must name a pid')
            }
            release()
        })
    })
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

        it('leaves no .tmp file behind after an acquire/release cycle', function () {
            const file = path.join(dir, 'tmp.lock')
            const release = acquireInstanceLock(file)
            assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [])
            release()
            assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [])
        })

        it('waits out an illegible lock instead of breaking it on sight', function () {
            const file = path.join(dir, 'initializing.lock')
            // A zero-byte lock is an owner mid-publication on the no-hardlink
            // fallback path, not a stale lock, so it must not be unlinked on sight.
            // The ELAPSED TIME is the measurement: the bounded re-check has to
            // expire before the break, and breaking on sight returns in no time.
            fs.writeFileSync(file, '')
            const started = Date.now()
            const release = acquireInstanceLock(file, {}, { isPidAlive: () => true })
            const elapsed = Date.now() - started
            assert.ok(elapsed >= 50,
                'an illegible lock must be re-read before it is judged stale, took ' + elapsed + 'ms')
            assert.strictEqual(heldPid(file), process.pid, 'and it is still recoverable afterwards')
            release()
        })
    })
})

describe('singleInstanceGuard', function () {
    describe('acquireInstanceLock', function () {
        beforeEach(createLockDirectory)
        afterEach(removeLockDirectory)

        it('release does not delete a lock that has changed hands', function () {
            const file = path.join(dir, 'ownership.lock')
            const release = acquireInstanceLock(file)
            // A successor's record at the same path: a pid-reuse break leaves the
            // ruled-stale process alive and still holding a release closure.
            const successor = JSON.stringify({ pid: 999999, cmd: 'node other', token: 'f'.repeat(32) })
            fs.writeFileSync(file, successor)
            release()
            assert.strictEqual(fs.existsSync(file), true,
                'unlinking by path alone is how one owner\'s exit freed another owner\'s lock')
            assert.strictEqual(fs.readFileSync(file, 'utf8'), successor)
        })

        it('records an ownership token, which is what release verifies against', function () {
            const file = path.join(dir, 'token.lock')
            const release = acquireInstanceLock(file)
            const record = JSON.parse(fs.readFileSync(file, 'utf8'))
            assert.match(record.token, /^[0-9a-f]{32}$/)
            release()
            assert.strictEqual(fs.existsSync(file), false)
        })
    })
})
