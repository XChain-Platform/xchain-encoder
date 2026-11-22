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
 * A request whose Content-Type is not JSON leaves the body unparsed. It must be
 * refused as a 4xx JSON-RPC 2.0 Invalid Request with id null, carrying the
 * jsonrpc member, never answered 200 by the router's own member-less error.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')

const API_PATH = require.resolve('../../../src/api.js')
const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })

// Require src/api.js fresh with no key and no limiter, restoring env and module cache.
function loadApi () {
    const keys = ['API_KEY', 'ENCODER_RATE_LIMIT_RPM', 'NODE_ENV', 'NETWORK']
    const prior = {}
    for (const k of keys) prior[k] = process.env[k]
    for (const k of keys.slice(0, 3)) delete process.env[k]
    if (!process.env.NETWORK) process.env.NETWORK = 'bitcoin-regtest'
    const cached = require.cache[API_PATH]
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

async function post (app, contentType, body) {
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
            method: 'POST', headers: { 'Content-Type': contentType }, body
        })
        return { status: res.status, text: await res.text() }
    } finally {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    }
}

describe('a non-JSON Content-Type is refused as JSON-RPC Invalid Request @regression', function () {
    this.timeout(10000)
    let api
    before(function () { api = loadApi() })

    it('answers a text/plain ping 400 with jsonrpc 2.0, id null and code -32600', async function () {
        const res = await post(api.app, 'text/plain', PING)
        assert.strictEqual(res.status, 400)
        const body = JSON.parse(res.text)
        assert.strictEqual(body.jsonrpc, '2.0')
        assert.strictEqual(body.id, null)
        assert.strictEqual(body.error.code, -32600)
        assert.doesNotMatch(res.text, /node_modules|at \w+ \(|stack/i)
    })

    it('still answers an application/json ping 200 with jsonrpc 2.0', async function () {
        const res = await post(api.app, 'application/json', PING)
        assert.strictEqual(res.status, 200)
        const body = JSON.parse(res.text)
        assert.strictEqual(body.jsonrpc, '2.0')
        assert.strictEqual(body.result.status, 'success')
    })
})
