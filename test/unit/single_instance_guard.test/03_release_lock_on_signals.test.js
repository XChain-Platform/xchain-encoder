const assert = require('assert')

const { releaseLockOnSignals } = require('../../../src/server/single_instance_guard')

// The lock is released on the way out through a SIGNAL, because that is how
// this process actually dies: `docker stop` and `docker restart`
// send SIGTERM, and 'exit' does not fire for that. A fake process stands in
// so the assertions do not depend on signalling the test runner.

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

describe('singleInstanceGuard', function () {
    describe('releaseLockOnSignals', function () {
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
    })
})

describe('singleInstanceGuard', function () {
    describe('releaseLockOnSignals', function () {
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
            // recorded and there is nothing to wait for; the fallback timer fires
            // into nothing. What must not happen is a SECOND, different exit path
            // being taken while the signalled death is already in flight.
            assert.deepStrictEqual(proc.killed, [[4242, 'SIGTERM']])
        })
    })
})

describe('singleInstanceGuard', function () {
    describe('releaseLockOnSignals', function () {
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
    })
})

describe('singleInstanceGuard', function () {
    describe('releaseLockOnSignals', function () {
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
