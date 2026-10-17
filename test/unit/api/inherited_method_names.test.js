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
 * The JSON-RPC router decides a method exists with `method in controller`,
 * which also finds names inherited from Object.prototype. These tests pin that
 * the encoder's dispatch table holds only its own methods, so `constructor`,
 * `toString` and the rest answer -32601 Method not found like any unknown name.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const http = require('http')

const API_PATH = require.resolve('../../../src/api.js')
const JSON_RPC_METHODS_PATH = require.resolve('../../../src/api/json_rpc_methods.js')
const API_KEY_ENV = ['API', 'KEY'].join('_')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods.js')

// Every name a plain object inherits; none of them is an encoder method.
const INHERITED = [
    'constructor', 'valueOf', 'toString', 'toLocaleString', 'hasOwnProperty',
    'isPrototypeOf', 'propertyIsEnumerable', '__proto__', '__defineGetter__',
    '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
]

// POST one JSON body to the bound app and parse the JSON reply.
function postRpc (server, payload) {
    const body = JSON.stringify(payload)
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            path: '/',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (err) { reject(err) }
            })
        })
        req.on('error', reject)
        req.end(body)
    })
}

describe('JSON-RPC controller holds only its own methods', function () {
    it('finds no inherited name in the dispatch table', function () {
        const controller = createJsonRpcController({ encoder: {}, NETWORK: 'bitcoin-regtest' })
        for (const name of INHERITED) {
            assert.ok(!(name in controller), `${name} is reachable through the router's \`in\` check`)
        }
    })

    it('still carries the real methods as own functions', function () {
        const controller = createJsonRpcController({ encoder: {}, NETWORK: 'bitcoin-regtest' })
        for (const name of ['ping', 'health', 'create_tx', 'broadcast_tx']) {
            assert.ok(Object.hasOwn(controller, name), `${name} must be an own key`)
            assert.strictEqual(typeof controller[name], 'function')
        }
    })
})

// Load the real app in open mode (no key gate) with dotenv and the maintenance file stubbed out.
async function startOpenApp() {
    const dotenv = require('dotenv')
    const maintenance = require('../../../src/server/maintenance_window')
    const state = { cachedApi: require.cache[API_PATH], cachedMethods: require.cache[JSON_RPC_METHODS_PATH] }
    const originalDotenvConfig = dotenv.config
    const originalReadMaintenanceWindow = maintenance.readMaintenanceWindow
    const priorNetwork = process.env.NETWORK
    const priorApiKey = process.env[API_KEY_ENV]
    dotenv.config = () => ({ parsed: {} })
    maintenance.readMaintenanceWindow = async () => null
    process.env.NETWORK = 'bitcoin-regtest'
    delete process.env[API_KEY_ENV]
    delete require.cache[API_PATH]
    delete require.cache[JSON_RPC_METHODS_PATH]
    let api
    try {
        api = require(API_PATH)
    } finally {
        dotenv.config = originalDotenvConfig
        maintenance.readMaintenanceWindow = originalReadMaintenanceWindow
        if (priorNetwork === undefined) delete process.env.NETWORK
        else process.env.NETWORK = priorNetwork
        if (priorApiKey === undefined) delete process.env[API_KEY_ENV]
        else process.env[API_KEY_ENV] = priorApiKey
    }
    state.server = await new Promise(resolve => {
        const listener = api.app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    return state
}

// Close the listener and put the module cache back as it was.
async function stopOpenApp(state) {
    if (!state) return
    if (state.server) {
        if (typeof state.server.closeAllConnections === 'function') state.server.closeAllConnections()
        await new Promise(resolve => state.server.close(resolve))
    }
    delete require.cache[API_PATH]
    delete require.cache[JSON_RPC_METHODS_PATH]
    if (state.cachedApi) require.cache[API_PATH] = state.cachedApi
    if (state.cachedMethods) require.cache[JSON_RPC_METHODS_PATH] = state.cachedMethods
}

describe('JSON-RPC controller holds only its own methods over HTTP', function () {
    this.timeout(10000)
    let app
    let server

    before(async function () {
        app = await startOpenApp()
        server = app.server
    })

    after(async function () {
        await stopOpenApp(app)
    })

    it('answers -32601 for constructor instead of echoing the params', async function () {
        const body = await postRpc(server, { jsonrpc: '2.0', id: 1, method: 'constructor', params: { probe: 1 } })
        assert.strictEqual(body.result, undefined, `constructor dispatched: ${JSON.stringify(body)}`)
        assert.strictEqual(body.error.code, -32601)
        assert.strictEqual(body.id, 1)
    })

    it('answers -32601 for every inherited name in one batch', async function () {
        const batch = INHERITED.map((method, i) => ({ jsonrpc: '2.0', id: i + 1, method, params: {} }))
        const replies = await postRpc(server, batch)
        assert.strictEqual(replies.length, INHERITED.length)
        for (const reply of replies) {
            const name = INHERITED[reply.id - 1]
            assert.strictEqual(reply.result, undefined, `${name} dispatched: ${JSON.stringify(reply)}`)
            assert.strictEqual(reply.error.code, -32601, `${name}: ${JSON.stringify(reply.error)}`)
        }
    })

    it('still dispatches a real method', async function () {
        const body = await postRpc(server, { jsonrpc: '2.0', id: 99, method: 'ping' })
        assert.strictEqual(body.result.status, 'success')
    })
})
