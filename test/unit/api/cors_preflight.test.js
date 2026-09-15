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
 * The cors() mount has to sit ABOVE the x-api-key gate, and only a test that
 * drives the real app can say whether it does.
 *
 * A browser preflight is an OPTIONS carrying no x-api-key (that header is not
 * CORS-safelisted, which is exactly what forces the preflight), so a key gate
 * mounted first answers it 401 with no Access-Control-Allow-* headers and the
 * browser never sends the real request. A keyed deploy that also sets
 * CORS_ORIGIN is then unusable from every wallet shell while a non-preflighted
 * curl header dump reads as correctly configured.
 *
 * Asserting against a hand-built mirror of the middleware stack cannot catch
 * that, because a mirror keeps its own ordering. These tests bind the app
 * exported from src/api.js.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')

const API_PATH = require.resolve('../../src/api.js')
const ORIGIN   = 'https://wallet.example'
const API_KEY  = 'preflight-test-key'

// Build the app the way a keyed deploy does. The gate and CORS_ORIGIN are read
// once at module load, so the env has to be in place for a fresh require; the
// cached entry is put back so suites that already hold the app keep their own.
//
// NETWORK is supplied here rather than inherited. A developer checkout carries a
// gitignored .env that sets it, and a CI checkout does not, so a test that reads
// it from the ambient environment passes locally and fails on the venue with
// "Unknown network: undefined" from the encoder constructor. Any valid network
// serves: the mount order under test is network-independent.
function loadKeyedApp (corsOrigin) {
    const cached = require.cache[API_PATH]
    const priorKey = process.env.API_KEY
    const priorOrigin = process.env.CORS_ORIGIN
    const priorNetwork = process.env.NETWORK

    process.env.API_KEY = API_KEY
    if (!process.env.NETWORK) process.env.NETWORK = 'bitcoin-regtest'
    if (corsOrigin === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = corsOrigin
    delete require.cache[API_PATH]
    try {
        return require(API_PATH).app
    } finally {
        delete require.cache[API_PATH]
        if (cached) require.cache[API_PATH] = cached
        if (priorKey === undefined) delete process.env.API_KEY
        else process.env.API_KEY = priorKey
        if (priorOrigin === undefined) delete process.env.CORS_ORIGIN
        else process.env.CORS_ORIGIN = priorOrigin
        if (priorNetwork === undefined) delete process.env.NETWORK
        else process.env.NETWORK = priorNetwork
    }
}

async function withServer (app, fn) {
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
        return await fn(`http://127.0.0.1:${server.address().port}`)
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

describe('CORS is mounted above the API-key gate @regression', function () {
    let app

    before(function () {
        app = loadKeyedApp(ORIGIN)
    })

    it('answers a preflight instead of 401ing it, on a keyed deploy', async function () {
        const res = await withServer(app, base => fetch(`${base}/`, {
            method: 'OPTIONS',
            headers: {
                Origin: ORIGIN,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'x-api-key'
            }
        }))

        assert.notStrictEqual(res.status, 401,
            'the preflight carries no x-api-key by construction, so a 401 here means the gate is mounted first')
        assert.ok(res.status < 300, `preflight should be answered, got ${res.status}`)
        assert.strictEqual(res.headers.get('access-control-allow-origin'), ORIGIN)
    })

    // The same ordering decides whether a browser can read the gate's own
    // rejections: without CORS headers a 401 arrives as an opaque network error.
    it('emits CORS headers on the 401 the gate returns', async function () {
        const res = await withServer(app, base => fetch(`${base}/`, {
            method: 'POST',
            headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'health' })
        }))

        assert.strictEqual(res.status, 401, 'a keyless request must still be rejected')
        assert.strictEqual(res.headers.get('access-control-allow-origin'), ORIGIN)
    })

    it('still rejects a wrong key', async function () {
        const res = await withServer(app, base => fetch(`${base}/`, {
            method: 'POST',
            headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'x-api-key': 'not-the-key' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'health' })
        }))

        assert.strictEqual(res.status, 401)
    })

    it('lets a correctly keyed request past the gate', async function () {
        const res = await withServer(app, base => fetch(`${base}/`, {
            method: 'POST',
            headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'x-api-key': API_KEY },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'no_such_method' })
        }))

        assert.notStrictEqual(res.status, 401, 'a valid key must not be rejected')
    })
})

/* Moving the mount up must not widen anything when CORS is off, which is the
 * default and what every production encoder runs today. It does not: handed
 * `origin: false`, the cors package builds no origin callback and calls next()
 * for every method, OPTIONS included, so the middleware is a pass-through and
 * the gate answers exactly as it did with the mount below it. */
describe('a CORS-disabled keyed deploy is unchanged by the mount position @regression', function () {
    let app

    before(function () {
        app = loadKeyedApp(undefined)
    })

    it('still 401s an unauthenticated preflight and grants no origin', async function () {
        const res = await withServer(app, base => fetch(`${base}/`, {
            method: 'OPTIONS',
            headers: {
                Origin: ORIGIN,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'x-api-key'
            }
        }))

        assert.strictEqual(res.status, 401, 'CORS off means the gate still owns OPTIONS')
        assert.strictEqual(res.headers.get('access-control-allow-origin'), null)
    })

    it('grants no origin on a keyed request either', async function () {
        const res = await withServer(app, base => fetch(`${base}/`, {
            method: 'POST',
            headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'x-api-key': API_KEY },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'no_such_method' })
        }))

        assert.strictEqual(res.headers.get('access-control-allow-origin'), null)
    })
})
