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
 * Security: rate-limit refusal counter/logger
 *
 * Covers src/rateLimitLog.js directly (the 429 body, the once-per-window
 * log line, the silence in between, and the accumulated-count reset) with
 * an injectable clock/logger so nothing here needs a real timer, plus one
 * end-to-end pass through express-rate-limit to prove the draft-6 headers
 * a watchdog checks still land on the 429 this handler sends. A closing
 * source check pins src/api.js's limiter to this handler rather than a
 * bare `message:` option.
 *
 * Run: mocha test/security/rate-limit-log.test.js --timeout 30000
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const express = require('express')
const rateLimit = require('express-rate-limit')
const http = require('http')
const { limitedHandler } = require('../../src/rateLimitLog.js')

const MESSAGE = { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Too many requests' } }

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this },
        json(body) { this.body = body; return this }
    }
}

// Extracts the parenthesised call starting at `openIdx` (str[openIdx] === '(')
// by counting balanced parens, so the source check below does not depend on
// formatting/indentation to find where one call ends and the next begins.
function extractBalanced(str, openIdx) {
    let depth = 0
    for (let i = openIdx; i < str.length; i++) {
        if (str[i] === '(') depth++
        else if (str[i] === ')') {
            depth--
            if (depth === 0) return str.slice(openIdx, i + 1)
        }
    }
    throw new Error('unbalanced parens from index ' + openIdx)
}

describe('Security: rate-limit refusal counter/logger', () => {

    describe('limitedHandler', () => {
        it('sends 429 with the exact JSON-RPC body the message option carried', () => {
            const handler = limitedHandler({
                service: 'Encoder', name: 'app-wide', envVar: 'ENCODER_RATE_LIMIT_RPM',
                limit: 60, windowMs: 60000, message: MESSAGE, log: () => {}, now: () => 0
            })
            const res = makeRes()
            handler({}, res, () => {}, {})
            assert.strictEqual(res.statusCode, 429)
            assert.deepStrictEqual(res.body, MESSAGE)
        })

        it('logs one line at the first refusal of a window, with count 1', () => {
            const lines = []
            const handler = limitedHandler({
                service: 'Encoder', name: 'app-wide', envVar: 'ENCODER_RATE_LIMIT_RPM',
                limit: 60, windowMs: 60000, message: MESSAGE, log: (l) => lines.push(l), now: () => 1000
            })
            handler({}, makeRes(), () => {}, {})
            assert.strictEqual(lines.length, 1)
            assert.strictEqual(
                lines[0],
                'Encoder rate limit [app-wide]: 1 request refused in the last 60 s (limit 60/60 s); raise ENCODER_RATE_LIMIT_RPM if this is legitimate traffic'
            )
        })

        it('logs nothing more for refusals inside the same window', () => {
            const lines = []
            let t = 1000
            const handler = limitedHandler({
                service: 'Encoder', name: 'app-wide', envVar: 'ENCODER_RATE_LIMIT_RPM',
                limit: 60, windowMs: 60000, message: MESSAGE, log: (l) => lines.push(l), now: () => t
            })
            handler({}, makeRes(), () => {}, {}) // first refusal: logs
            t = 1000 + 30000 // 30s later, still inside the 60s window
            handler({}, makeRes(), () => {}, {})
            handler({}, makeRes(), () => {}, {})
            handler({}, makeRes(), () => {}, {})
            assert.strictEqual(lines.length, 1)
        })

        it('logs the count accumulated since the last line at the first refusal after a full window, then resets', () => {
            const lines = []
            let t = 0
            const handler = limitedHandler({
                service: 'Encoder', name: 'app-wide', envVar: 'ENCODER_RATE_LIMIT_RPM',
                limit: 60, windowMs: 60000, message: MESSAGE, log: (l) => lines.push(l), now: () => t
            })
            handler({}, makeRes(), () => {}, {}) // t=0: first ever, logs count 1

            t = 10000
            for (let i = 0; i < 4; i++) handler({}, makeRes(), () => {}, {}) // 4 silent refusals

            t = 60000 // exactly windowMs after the last logged line
            handler({}, makeRes(), () => {}, {}) // 5th silent refusal is the trigger: logs 5, resets

            assert.strictEqual(lines.length, 2)
            assert.strictEqual(
                lines[1],
                'Encoder rate limit [app-wide]: 5 requests refused in the last 60 s (limit 60/60 s); raise ENCODER_RATE_LIMIT_RPM if this is legitimate traffic'
            )

            // Reset confirmed: a refusal just after the log point does not log again.
            t = 60001
            handler({}, makeRes(), () => {}, {})
            assert.strictEqual(lines.length, 2)
        })
    })

    describe('wired into a real express-rate-limit instance', () => {
        let server

        afterEach(() => {
            if (server) {
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
                server.close()
                server = null
            }
        })

        it('carries the draft-6 RateLimit-Policy/Limit and Retry-After headers on the 429 this handler sends', async () => {
            const app = express()
            app.use(rateLimit({
                windowMs: 60000,
                limit: 2,
                standardHeaders: true,
                legacyHeaders: false,
                handler: limitedHandler({
                    service: 'Encoder', name: 'app-wide', envVar: 'ENCODER_RATE_LIMIT_RPM',
                    limit: 2, windowMs: 60000, message: MESSAGE, log: () => {}
                })
            }))
            app.get('/ping', (req, res) => res.json({ ok: true }))

            server = http.createServer(app)
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
            const base = 'http://127.0.0.1:' + server.address().port

            await fetch(base + '/ping')
            await fetch(base + '/ping')
            const third = await fetch(base + '/ping')

            assert.strictEqual(third.status, 429)
            assert.ok(third.headers.get('retry-after'), 'expected a Retry-After header')
            assert.ok(third.headers.get('ratelimit-policy'), 'expected a RateLimit-Policy header')
            assert.strictEqual(third.headers.get('ratelimit-limit'), '2')
            const body = await third.json()
            assert.deepStrictEqual(body, MESSAGE)
        })
    })

    describe('src/api.js wiring', () => {
        it('routes the limiter through limitedHandler and carries no bare message: option', () => {
            const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8')

            const callStart = src.indexOf('const limiter = rateLimit(')
            assert.notStrictEqual(callStart, -1, 'expected `const limiter = rateLimit(...)` in src/api.js')
            const openIdx = src.indexOf('(', callStart + 'const limiter = rateLimit'.length)
            const rateLimitCall = extractBalanced(src, openIdx)

            assert.match(rateLimitCall, /handler:\s*limitedHandler\(/)

            // Strip the nested limitedHandler(...) call (which legitimately carries
            // its own `message:` field) before checking the outer options object
            // for a bare `message:` - the shape rateLimit() would answer with
            // itself, unlogged, if the handler wiring ever regressed.
            const handlerCallStart = rateLimitCall.indexOf('limitedHandler(')
            const handlerOpenIdx = handlerCallStart + 'limitedHandler'.length
            const handlerCall = extractBalanced(rateLimitCall, handlerOpenIdx)
            const outerOnly = rateLimitCall.slice(0, handlerCallStart) + rateLimitCall.slice(handlerCallStart + handlerCall.length)

            assert.doesNotMatch(outerOnly, /message\s*:/, 'rateLimit({...}) must not carry a bare message: option outside limitedHandler(...)')
        })
    })
})
