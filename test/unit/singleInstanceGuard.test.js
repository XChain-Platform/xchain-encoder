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

const { assertSingleInstance, acquireInstanceLock, isPidAlive } = require('../../src/singleInstanceGuard')

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
            assert.strictEqual(fs.readFileSync(file, 'utf8'), String(process.pid))
            release()
            assert.strictEqual(fs.existsSync(file), false)
            release() // idempotent
        })

        it('refuses when a live other process holds the lock', function () {
            const file = path.join(dir, 'b.lock')
            // PID 1 (init/launchd) is always alive and never our own pid.
            fs.writeFileSync(file, '1')
            assert.throws(() => acquireInstanceLock(file), /Another xchain-encoder instance \(pid 1\)/)
            // Lock left intact for the real holder.
            assert.strictEqual(fs.readFileSync(file, 'utf8'), '1')
        })

        it('breaks a stale lock held by a dead pid', function () {
            const file = path.join(dir, 'c.lock')
            // Find a dead pid.
            let deadPid = 99999
            while (isPidAlive(deadPid)) deadPid--
            fs.writeFileSync(file, String(deadPid))
            const release = acquireInstanceLock(file)
            assert.strictEqual(fs.readFileSync(file, 'utf8'), String(process.pid))
            release()
        })

        it('breaks a lock with garbage contents', function () {
            const file = path.join(dir, 'd.lock')
            fs.writeFileSync(file, 'not-a-pid')
            const release = acquireInstanceLock(file)
            assert.strictEqual(fs.readFileSync(file, 'utf8'), String(process.pid))
            release()
        })

        it('re-takes a lock recorded under our own pid (crash-restart same pid file)', function () {
            const file = path.join(dir, 'e.lock')
            fs.writeFileSync(file, String(process.pid))
            const release = acquireInstanceLock(file)
            assert.strictEqual(fs.readFileSync(file, 'utf8'), String(process.pid))
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
})
