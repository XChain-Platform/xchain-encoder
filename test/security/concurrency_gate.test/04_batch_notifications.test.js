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
 * Security: id-less batch entries cannot escape the held slot
 *
 * The JSON-RPC router starts every batch entry but awaits only those that
 * carry an id, so an all-notification batch would answer [] and free its
 * slot while every build it started was still running.
 ********************************************************************/

'use strict'

const assert = require('assert')
const express = require('express')
const http = require('http')
const jsonRouter = require('express-json-rpc-router')
const { createConcurrencyGate } = require('../../../src/server/concurrency_gate.js')

// api.js constructs the encoder at require time from env. Set placeholders ONLY for the
// require, then restore, so this file does not pollute process.env for other test files.
const envKeys = ['NETWORK', 'NODE_URL', 'NODE_PORT', 'NODE_USER', 'NODE_PASSWORD']
const savedEnv = {}
for (const k of envKeys) {
    savedEnv[k] = process.env[k]
    if (process.env[k] === undefined) {
        process.env[k] = (k === 'NETWORK') ? 'bitcoin-regtest' : (k === 'NODE_PORT') ? '8333' : 'x'
    }
}
const { makeRpcBatchGuard } = require('../../../src/api')
for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
}

const BATCH = 5

// Build api.js's shape: body parser, gate, batch guard, then the held router.
// withGuard:false is the pre-fix wiring and serves as the negative control.
function buildApp({ withGuard }){
    const state = { calls: 0, settled: 0 }
    const gate = createConcurrencyGate({ limit: 50 })
    const app = express()
    app.use(express.json())
    app.use(gate)
    if (withGuard) app.use(makeRpcBatchGuard(20))
    app.use(gate.hold(jsonRouter({ methods: {
        slow: () => {
            state.calls++
            return new Promise(resolve => setTimeout(() => { state.settled++; resolve('ok') }, 300))
        }
    } })))
    const server = http.createServer(app)
    return { gate, server, state }
}

function listen(server){
    return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

function post(server, body){
    return fetch('http://127.0.0.1:' + server.address().port + '/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
}

function notifications(){
    return Array.from({ length: BATCH }, () => ({ jsonrpc: '2.0', method: 'slow' }))
}

function withIds(){
    return Array.from({ length: BATCH }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'slow' }))
}

async function waitSettled(state){
    const deadline = Date.now() + 3000
    while (state.settled < state.calls && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
}

describe('Security: id-less batch entries cannot escape the held slot', function () {
    this.timeout(10000)
    let servers = []
    afterEach(function () {
        for (const s of servers) {
            if (typeof s.closeAllConnections === 'function') s.closeAllConnections()
            s.close()
        }
        servers = []
    })

    it('control: without the guard an all-notification batch frees its slot while its builds still run', async function () {
        const { gate, server, state } = buildApp({ withGuard: false })
        servers.push(server)
        await listen(server)
        const response = await post(server, notifications())
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(await response.json(), [])
        assert.strictEqual(state.calls, BATCH)
        assert.ok(state.settled < BATCH, 'the builds should still be running when the response lands')
        assert.strictEqual(gate.getStats().in_flight, 0)
        await waitSettled(state)
    })

    it('refuses an all-notification batch with -32600 before any method runs', async function () {
        const { gate, server, state } = buildApp({ withGuard: true })
        servers.push(server)
        await listen(server)
        const response = await post(server, notifications())
        assert.strictEqual(response.status, 400)
        const body = await response.json()
        assert.strictEqual(body.error.code, -32600)
        assert.strictEqual(state.calls, 0)
        assert.strictEqual(gate.getStats().in_flight, 0)
    })

    it('holds the slot for a batch of id-bearing entries until every method settles', async function () {
        const { gate, server, state } = buildApp({ withGuard: true })
        servers.push(server)
        await listen(server)
        const pending = post(server, withIds())
        const deadline = Date.now() + 2000
        while (state.calls < BATCH && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
        assert.strictEqual(state.calls, BATCH)
        assert.ok(gate.getStats().in_flight > 0, 'the slot should be held while the methods are pending')
        const response = await pending
        assert.strictEqual(response.status, 200)
        const body = await response.json()
        assert.strictEqual(body.length, BATCH)
        assert.strictEqual(state.settled, BATCH)
        assert.strictEqual(gate.getStats().in_flight, 0)
    })
})
