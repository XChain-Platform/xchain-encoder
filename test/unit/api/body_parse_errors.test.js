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
 * A body the JSON parser refuses (malformed, or over the size bound) must be
 * answered as JSON-RPC by the app's own error handler, never by Express's
 * default handler, which serves the error stack as HTML outside production.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')

const { errorReply } = require('../../../src/server/json_error_handler')

const API_PATH = require.resolve('../../../src/api.js')
const BIG_BODY = 'x'.repeat(3.5 * 1024 * 1024)

// Require src/api.js fresh with no NODE_ENV, no key and no limiter, restoring env and module cache.
function loadApi () {
    const env = { API_KEY: undefined, ENCODER_RATE_LIMIT_RPM: undefined, NODE_ENV: undefined }
    const cached = require.cache[API_PATH]
    const keys = Object.keys(env).concat('NETWORK')
    const prior = {}
    for (const k of keys) prior[k] = process.env[k]
    if (!process.env.NETWORK) process.env.NETWORK = 'bitcoin-regtest'
    for (const k of Object.keys(env)) delete process.env[k]
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

// Post one raw body to a fresh listener and return status, content type and text.
async function postRaw (app, body) {
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body
        })
        return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() }
    } finally {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    }
}

describe('a body the JSON parser refuses answers JSON-RPC, never a stack page @regression', function () {
    this.timeout(10000)
    let api
    before(function () { api = loadApi() })

    it('answers a malformed body 400 with a -32700 Parse error and no stack', async function () {
        const res = await postRaw(api.app, '{not json')
        assert.strictEqual(res.status, 400)
        assert.match(res.type, /application\/json/)
        assert.deepStrictEqual(JSON.parse(res.text), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        assert.doesNotMatch(res.text, /node_modules|at \w|SyntaxError/)
    })

    it('answers an over-limit body 413 with a fixed JSON-RPC message', async function () {
        const res = await postRaw(api.app, BIG_BODY)
        assert.strictEqual(res.status, 413)
        assert.deepStrictEqual(JSON.parse(res.text), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request body too large' } })
    })

    it('maps any other client error to Invalid Request and a server fault to a generic Internal error', function () {
        assert.deepStrictEqual(errorReply({ status: 415, type: 'charset.unsupported' }), { status: 415, code: -32600, message: 'Invalid Request' })
        assert.deepStrictEqual(errorReply(new Error('boom at /XChainEncoder/src')), { status: 500, code: -32603, message: 'Internal error' })
    })
})
