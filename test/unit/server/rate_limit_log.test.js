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
 * The refusal lines must account for every 429 a client saw, and each line
 * must cover only the window that caused it. Before the end-of-window flush,
 * the refusals after a burst's first line were never written unless another
 * refusal came a full window later, and that one then folded them into a
 * line spanning the whole idle gap. Driven with an injected clock, a manual
 * timer queue on the same clock, and a log sink.
 *
 **********************************************************************/

'use strict'

const assert = require('assert')

const { limitedHandler } = require('../../../src/server/rate_limit_log.js')

const MESSAGE = { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests' }, id: null }
const WINDOW_MS = 60000

function makeRes() {
    return {
        status(code) { this.statusCode = code; return this },
        json(body) { this.body = body; return this }
    }
}

// Manual timers on the fake clock: advanceTo() fires every timer due by then.
function fakeTimers(clock) {
    const pending = []
    return {
        pending,
        setTimer(fn, ms) {
            const handle = { fn, at: clock.t + ms, unrefd: false, unref() { this.unrefd = true; return this } }
            pending.push(handle)
            return handle
        },
        clearTimer(handle) {
            const i = pending.indexOf(handle)
            if (i >= 0) pending.splice(i, 1)
        },
        advanceTo(t) {
            for (;;) {
                pending.sort((a, b) => a.at - b.at)
                if (!pending.length || pending[0].at > t) break
                const h = pending.shift()
                clock.t = h.at
                h.fn()
            }
            clock.t = t
        }
    }
}

function setup() {
    const clock = { t: 0 }
    const lines = []
    const timers = fakeTimers(clock)
    const handler = limitedHandler({
        service: 'Encoder', name: 'app-wide', envVar: 'ENCODER_RATE_LIMIT_RPM',
        limit: 60, windowMs: WINDOW_MS, message: MESSAGE,
        log: (l) => lines.push(l), now: () => clock.t,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer
    })
    const refuse = () => handler({}, makeRes(), () => {}, {})
    return { clock, lines, timers, refuse }
}

function parseLine(line) {
    const m = /: (\d+) requests? refused in the last (\d+) s/.exec(line)
    return { count: Number(m[1]), span: Number(m[2]) }
}

describe('encoder rate-limit refusal logger: burst tail flush', () => {
    it('logs the refusals of a burst tail when the window ends, with no later refusal', () => {
        const { clock, lines, timers, refuse } = setup()
        for (let i = 0; i < 100; i++) {
            clock.t = Math.round(i * 30000 / 99)
            refuse()
        }
        assert.strictEqual(lines.length, 1)

        timers.advanceTo(WINDOW_MS)
        const parsed = lines.map(parseLine)
        assert.strictEqual(parsed.reduce((sum, p) => sum + p.count, 0), 100, 'every refusal a client saw is in the log')
        for (const p of parsed) assert.ok(p.span <= WINDOW_MS / 1000, `span ${p.span} s exceeds the window`)
        assert.strictEqual(timers.pending.length, 0, 'no timer stays armed once the tail is flushed')
    })

    it('a refusal long after a flushed burst logs a count of 1 over one window, not the idle gap', () => {
        const { clock, lines, timers, refuse } = setup()
        for (let i = 0; i < 100; i++) {
            clock.t = i * 300
            refuse()
        }
        timers.advanceTo(WINDOW_MS)
        const before = lines.length

        timers.advanceTo(WINDOW_MS + 30 * 60 * 1000)
        assert.strictEqual(lines.length, before, 'an idle limiter writes nothing')
        refuse()
        assert.strictEqual(lines.length, before + 1)
        const last = parseLine(lines[lines.length - 1])
        assert.strictEqual(last.count, 1)
        assert.ok(last.span <= WINDOW_MS / 1000, `span ${last.span} s exceeds the window`)
    })
})

describe('encoder rate-limit refusal logger: steady refusals', () => {
    it('sustained refusals log about once per window and every refusal is counted', () => {
        const { lines, timers, refuse } = setup()
        for (let i = 0; i < 3000; i++) {
            timers.advanceTo(i * 100)
            refuse()
        }
        timers.advanceTo(3000 * 100 + WINDOW_MS)
        const parsed = lines.map(parseLine)
        assert.strictEqual(parsed.reduce((sum, p) => sum + p.count, 0), 3000)
        assert.ok(lines.length <= 7, `${lines.length} lines: a line per refusal would flood the log`)
        for (const p of parsed) assert.ok(p.span <= WINDOW_MS / 1000, `span ${p.span} s exceeds the window`)
    })

    it('arms its flush timer unref()d so an idle limiter never holds the process open', () => {
        const { clock, timers, refuse } = setup()
        refuse()
        assert.strictEqual(timers.pending.length, 0, 'a lone refusal that was already logged needs no timer')
        clock.t = 1000
        refuse()
        assert.strictEqual(timers.pending.length, 1)
        assert.strictEqual(timers.pending[0].unrefd, true)
        timers.advanceTo(WINDOW_MS)
        assert.strictEqual(timers.pending.length, 0)
    })
})
