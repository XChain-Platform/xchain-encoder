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
 * Shared harness for the concurrency-gate security suite: a miniature encoder
 * with api.js's middleware order, handlers that park until released, and
 * one forged client IP per request.
 ********************************************************************/

'use strict'

const express   = require('express')
const http      = require('http')
const rateLimit = require('express-rate-limit')
const { createConcurrencyGate } = require('../../../src/server/concurrency_gate.js')

// The 429 body the gate serves in production (src/api.js). -32029 is the
// encoder's "too many requests" JSON-RPC code, shared with the per-IP limiter,
// so the two are told apart below by MESSAGE, not code.
const BUSY_BODY = { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Server busy, retry shortly' } }
// Use the production predicate, not a copy, so the suite gates what api.js mounts.
const { isProbe } = require('../../../src/server/probe_request.js')

// Requests Express routes to a probe handler besides the plain GET.
const PROBE_VARIANTS = [
    { label: 'HEAD /status',       path: '/status',       init: { method: 'HEAD' } },
    { label: 'GET /status/',       path: '/status/' },
    { label: 'GET /STATUS',        path: '/STATUS' },
    { label: 'HEAD /openrpc.json', path: '/openrpc.json', init: { method: 'HEAD' } }
]

// Servers opened by a test, torn down in afterEach.
let openServers = []

function configureApp(app){
    // Same trust-proxy default api.js uses (ENCODER_TRUST_PROXY), so an
    // X-Forwarded-For hop from the loopback peer becomes req.ip.
    app.set('trust proxy', 'loopback, uniquelocal')

    // The per-IP limiter at its production default. With one request per forged
    // IP, every bucket sees a single hit, so this can never be the thing that
    // sheds below; a 429 saying "Too many requests" instead of "Server busy"
    // would mean the test proved nothing.
    app.use(rateLimit({
        windowMs:        60 * 1000,
        limit:           60,
        standardHeaders: true,
        legacyHeaders:   false,
        message:         { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Too many requests' } }
    }))
}

function createGates(app, options){
    const probeGate = createConcurrencyGate({
        limit:      options.probeLimit !== undefined ? options.probeLimit : 16,
        retryAfter: 1,
        skip:       (req) => !isProbe(req),
        body:       BUSY_BODY
    })
    app.use(probeGate)

    const gate = createConcurrencyGate({
        limit:      options.limit,
        retryAfter: 1,
        skip:       isProbe,
        body:       BUSY_BODY
    })
    app.use(gate)

    return { probeGate, gate }
}

function mountRoutes(app, gates, options){
    const { gate, probeGate } = gates
    let releaseHeld, releaseProbe
    const held      = new Promise(resolve => { releaseHeld  = resolve })
    const heldProbe = new Promise(resolve => { releaseProbe = resolve })

    // Arrival counter, so a test can wait on the CONDITION that requests
    // reached the handler rather than on a fixed sleep. With the gate disabled
    // its own stats stay at zero, which is the assertion under test, so they
    // cannot double as the readiness signal.
    let expensiveArrivals = 0

    app.get('/expensive', async (req, res) => {
        expensiveArrivals++
        await held
        res.json({ ok: true, ip: req.ip })
    })

    // /held is /expensive wrapped in gate.hold(), which is the shape api.js
    // mounts the JSON-RPC router in. stubHold swaps the wrapper for a
    // pass-through, and that IS the pre-fix gate, so the held-slot assertions
    // below get a negative control instead of a second flavour of one route.
    let heldEntered = 0
    const wrap = options.stubHold ? (fn) => fn : gate.hold
    app.get('/held', wrap(async (req, res) => {
        heldEntered++
        await held
        res.json({ ok: true, ip: req.ip })
    }))

    // The real /status makes an HTTP round-trip to the utxo-tracker, so it can
    // be made to park exactly like an expensive route; opts in per test. It is
    // wrapped in probeGate.hold() the way api.js mounts it.
    let probeEntered = 0
    const wrapProbe = options.stubHold ? (fn) => fn : probeGate.hold
    app.get('/status', wrapProbe(async (req, res) => {
        probeEntered++
        if(options.parkProbes) await heldProbe
        res.json({ status: 'healthy' })
    }))
    app.get('/openrpc.json', (req, res) => res.json({ openrpc: '1.3.2' }))

    return {
        arrivals: () => expensiveArrivals, enteredHeld: () => heldEntered,
        enteredProbe: () => probeEntered,
        release: () => releaseHeld(), releaseProbe: () => releaseProbe() }
}

/**
 * Stand up a miniature encoder with api.js's exact middleware order: the
 * production per-IP limiter, the probe reserve, the main gate, then handlers
 * that park until the test releases them. Parking is what makes "concurrent"
 * deterministic - requests stay in flight until we say so.
 */
function buildServer(options){
    options = options || {}

    const app = express()
    configureApp(app)
    const { probeGate, gate } = createGates(app, options)
    const routes = mountRoutes(app, { gate, probeGate }, options)
    const server = http.createServer(app)
    openServers.push(server)

    return { app, gate, probeGate, server, ...routes }
}

function listen(server){
    return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

// Requests from N different "clients". One IP per request is the whole point:
// it is the traffic shape a per-IP limiter is blind to.
function get(server, path, ipSuffix, init){
    const url = 'http://127.0.0.1:' + server.address().port + path
    return fetch(url, Object.assign({ headers: { 'X-Forwarded-For': '203.0.113.' + ipSuffix } }, init || {}))
}

async function waitFor(predicate, label){
    const deadline = Date.now() + 2000
    while(Date.now() < deadline){
        if(predicate()) return
        await new Promise(r => setTimeout(r, 5))
    }
    throw new Error('timed out waiting for: ' + label)
}

function closeServers(){
    for(const server of openServers){
        // fetch keeps its sockets alive, so close() alone would hang.
        if(typeof server.closeAllConnections === 'function') server.closeAllConnections()
        server.close()
    }
    openServers = []
}

module.exports = { BUSY_BODY, PROBE_VARIANTS, isProbe, buildServer, listen, get, waitFor, closeServers }
