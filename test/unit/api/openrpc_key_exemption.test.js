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
 * On a keyed deploy the OpenRPC spec stays public for every request shape
 * Express routes to its handler: HEAD, any letter case and a trailing slash.
 * Everything else, /status included, still needs the key.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')

const { isSpecRequest, isProbe } = require('../../../src/server/probe_request.js')

const API_PATH = require.resolve('../../../src/api.js')
const API_KEY  = 'openrpc-exemption-test-key'

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
        return await fn(`http://127.0.0.1:${server.address().port}`)
    } finally {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    }
}

const PUBLIC_SHAPES = [
    { method: 'GET',  path: '/openrpc.json' },
    { method: 'HEAD', path: '/openrpc.json' },
    { method: 'GET',  path: '/openrpc.json/' },
    { method: 'GET',  path: '/OpenRPC.json' }
]

const KEYED_SHAPES = [
    { method: 'GET',  path: '/status' },
    { method: 'POST', path: '/openrpc.json' },
    { method: 'GET',  path: '/openrpc.jsonx' },
    { method: 'POST', path: '/' }
]

describe('isSpecRequest matches only the spec route', function () {
    it('accepts GET and HEAD on the spec path in any case, with or without a trailing slash', function () {
        for (const req of PUBLIC_SHAPES) assert.strictEqual(isSpecRequest(req), true, req.method + ' ' + req.path)
    })

    it('refuses /status, other methods and lookalike paths', function () {
        const refused = [
            { method: 'GET', path: '/status' }, { method: 'HEAD', path: '/status' },
            { method: 'POST', path: '/openrpc.json' }, { method: 'PUT', path: '/openrpc.json' },
            { method: 'OPTIONS', path: '/openrpc.json' }, { method: 'GET', path: '/openrpc.jsonx' },
            { method: 'GET', path: '/x/openrpc.json' }
        ]
        for (const req of refused) assert.strictEqual(isSpecRequest(req), false, req.method + ' ' + req.path)
    })

    it('leaves the probe predicate covering /status as before', function () {
        assert.strictEqual(isProbe({ method: 'HEAD', path: '/Status/' }), true)
        assert.strictEqual(isProbe({ method: 'GET', path: '/openrpc.json' }), true)
    })
})

describe('API-key gate exempts every spec request shape @regression', function () {
    this.timeout(10000)
    let keyed

    before(function () {
        keyed = loadApi({ API_KEY, ENCODER_RATE_LIMIT_RPM: undefined })
    })

    it('serves the spec without a key for GET, HEAD, a trailing slash and any case', async function () {
        await withServer(keyed.app, async base => {
            for (const shape of PUBLIC_SHAPES) {
                const res = await fetch(base + shape.path, { method: shape.method })
                assert.strictEqual(res.status, 200, shape.method + ' ' + shape.path)
            }
        })
    })

    it('still answers 401 without a key everywhere else, /status included', async function () {
        await withServer(keyed.app, async base => {
            for (const shape of KEYED_SHAPES) {
                const res = await fetch(base + shape.path, { method: shape.method })
                assert.strictEqual(res.status, 401, shape.method + ' ' + shape.path)
                assert.strictEqual((await res.json()).error.code, -32001)
            }
        })
    })
})
