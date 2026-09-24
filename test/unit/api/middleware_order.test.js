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
 * The JSON body parser sits below the API-key gate and the per-IP limiter, so
 * a request they refuse never pays a multi-megabyte synchronous parse, and
 * above the concurrency gates, so a slow upload cannot hold a gate slot while
 * its body trickles in. Only the real app can say where the parser is mounted,
 * so these tests bind the app exported from src/api.js.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const http   = require('http')

const API_PATH = require.resolve('../../../src/api.js')
const ORIGIN   = 'https://wallet.example'
const API_KEY  = 'middleware-order-test-key'
const BIG_BODY = 'x'.repeat(3.5 * 1024 * 1024)

// Require src/api.js fresh under the given env, restoring env and module cache.
function loadApi (env) {
    const cached = require.cache[API_PATH]
    const keys = Object.keys(env).concat('NETWORK')
    const prior = {}
    for (const k of keys) prior[k] = process.env[k]
    if (!process.env.NETWORK) process.env.NETWORK = 'bitcoin-regtest'
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
    delete require.cache[API_PATH]
    try {
        return require(API_PATH)
    } finally {
        delete require.cache[API_PATH]
        if (cached) require.cache[API_PATH] = cached
        for (const k of keys) {
            if (prior[k] === undefined) delete process.env[k]
            else process.env[k] = prior[k]
        }
    }
}

async function withServer (app, fn) {
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
        return await fn(`http://127.0.0.1:${server.address().port}`, server)
    } finally {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    }
}

function post (base, body, headers) {
    return fetch(`${base}/`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body
    })
}

describe('JSON body parser sits below the key gate and the limiter @regression', function () {
    this.timeout(10000)
    let keyed

    before(function () {
        keyed = loadApi({ API_KEY, CORS_ORIGIN: ORIGIN, ENCODER_RATE_LIMIT_RPM: undefined })
    })

    it('answers a wrong key 401 before parsing an unparseable body', async function () {
        const res = await withServer(keyed.app, base => post(base, '{not json', { 'x-api-key': 'wrong' }))
        assert.strictEqual(res.status, 401, 'a 400 here means the parser ran ahead of the key gate')
        assert.strictEqual((await res.json()).error.code, -32001)
    })

    it('answers a wrong key 401 on an over-limit body, readable and with CORS headers', async function () {
        const res = await withServer(keyed.app, base => post(base, BIG_BODY, { Origin: ORIGIN, 'x-api-key': 'wrong' }))
        assert.strictEqual(res.status, 401, 'a 413 here means the parser ran ahead of the key gate')
        assert.strictEqual(res.headers.get('access-control-allow-origin'), ORIGIN)
        assert.strictEqual((await res.json()).error.message, 'Unauthorized')
    })

    it('still parses a correctly keyed body and hands it to the JSON-RPC router', async function () {
        const res = await withServer(keyed.app, base => post(base,
            JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'no_such_method' }), { 'x-api-key': API_KEY }))
        const body = await res.json()
        assert.strictEqual(body.id, 7, 'the router echoes the parsed id')
        assert.strictEqual(body.error.code, -32601)
    })

    it('refuses a rate-limited request 429 before parsing its body', async function () {
        const limited = loadApi({ API_KEY: undefined, ENCODER_RATE_LIMIT_RPM: '1' })
        await withServer(limited.app, async base => {
            await post(base, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'no_such_method' }))
            const res = await post(base, '{not json')
            assert.strictEqual(res.status, 429, 'a 400 here means the parser ran ahead of the limiter')
            assert.strictEqual((await res.json()).error.code, -32029)
        })
    })
})

const SLOW_HEAD = '{"jsonrpc":"2.0",'
const SLOW_TAIL = '"id":3,"method":"no_such_method","pad":"' + 'p'.repeat(200) + '"}'

// Open a POST and send only the first chunk of its body; finish() sends the rest.
function startSlowUpload (server) {
    const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': SLOW_HEAD.length + SLOW_TAIL.length }
    })
    const response = new Promise((resolve, reject) => {
        req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
        req.on('error', reject)
    })
    req.write(SLOW_HEAD)
    return { finish: () => { req.end(SLOW_TAIL); return response } }
}

describe('JSON body parser sits above the concurrency gates @regression', function () {
    this.timeout(10000)

    it('holds no gate slot while a request body is still uploading', async function () {
        const api = loadApi({ API_KEY: undefined, ENCODER_RATE_LIMIT_RPM: undefined, ENCODER_MAX_CONCURRENT_REQUESTS: '1' })
        await withServer(api.app, async (base, server) => {
            const slow = startSlowUpload(server)
            // Deliberate delay, not a sync point: the claim is that in_flight STAYS 0.
            await new Promise(r => setTimeout(r, 100))
            assert.strictEqual(api.requestGate.getStats().in_flight, 0,
                'a slow upload holding a slot means the parser sits below the gate')
            const res = await post(base, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'no_such_method' }))
            assert.notStrictEqual(res.status, 429)
            assert.strictEqual(await slow.finish(), 200, 'the slow upload is still served once it completes')
        })
    })
})
