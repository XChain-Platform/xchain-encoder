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
 * Security: global in-flight concurrency cap 
 *
 * The encoder's per-IP rate limiter cannot see a stampede spread across many
 * source IPs: every bucket stays under its own limit while every create_tx
 * still fans out into coin-node and utxo-tracker RPCs on a shared upstream.
 * These tests drive the real gate over real HTTP with a DISTINCT forged client
 * IP per request, so a shed can only come from the global cap - the per-IP
 * limiter is mounted alongside at its production default and never fires.
 *
 * Run: mocha test/security/concurrency-gate.test.js --timeout 30000
 */

'use strict'

const assert    = require('assert')
const express   = require('express')
const http      = require('http')
const rateLimit = require('express-rate-limit')
const { createConcurrencyGate, resolveLimit } = require('../../src/concurrencyGate.js')

// The 429 body the gate serves in production (src/api.js). -32029 is the
// encoder's "too many requests" JSON-RPC code, shared with the per-IP limiter,
// so the two are told apart below by MESSAGE, not code.
const BUSY_BODY = { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Server busy, retry shortly' } }
const isProbe   = (req) => req.method === 'GET' && (req.path === '/status' || req.path === '/openrpc.json')

// Servers opened by a test, torn down in afterEach.
let openServers = []

/**
 * Stand up a miniature encoder with api.js's exact middleware order: the
 * production per-IP limiter, the probe reserve, the main gate, then handlers
 * that park until the test releases them. Parking is what makes "concurrent"
 * deterministic - requests stay in flight until we say so.
 */
function buildServer(options){
    options = options || {}

    const app = express()
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
    // The real /status makes an HTTP round-trip to the utxo-tracker, so it can
    // be made to park exactly like an expensive route; opts in per test.
    app.get('/status', async (req, res) => {
        if(options.parkProbes) await heldProbe
        res.json({ status: 'healthy' })
    })

    const server = http.createServer(app)
    openServers.push(server)

    return {
        app, gate, probeGate, server,
        arrivals: () => expensiveArrivals,
        release: () => releaseHeld(), releaseProbe: () => releaseProbe()
    }
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

describe('Security: global in-flight concurrency cap ', function () {

    afterEach(function () {
        for(const server of openServers){
            // fetch keeps its sockets alive, so close() alone would hang.
            if(typeof server.closeAllConnections === 'function') server.closeAllConnections()
            server.close()
        }
        openServers = []
    })

    it('refuses the (cap+1)th concurrent request with 429, though every request has a distinct IP', async function () {
        const CAP = 3
        const { server, gate, release } = buildServer({ limit: CAP })
        await listen(server)

        // Saturate: CAP requests, CAP distinct source IPs, all parked in the handler.
        const parked = []
        for(let i = 1; i <= CAP; i++) parked.push(get(server, '/expensive', i))
        await waitFor(() => gate.getStats().in_flight === CAP, 'gate to reach its cap')

        // The overflow request comes from yet another IP that has never been seen.
        const overflow = await get(server, '/expensive', CAP + 1)
        assert.strictEqual(overflow.status, 429)
        assert.strictEqual(overflow.headers.get('retry-after'), '1')

        const body = await overflow.json()
        // "Server busy" proves the global cap shed it, not the per-IP limiter.
        assert.strictEqual(body.error.message, 'Server busy, retry shortly')
        assert.strictEqual(gate.getStats().shed, 1)

        // The parked requests were genuinely concurrent and genuinely distinct clients.
        release()
        const settled = await Promise.all(parked)
        const ips = []
        for(const response of settled){
            assert.strictEqual(response.status, 200)
            ips.push((await response.json()).ip)
        }
        assert.strictEqual(new Set(ips).size, CAP)
    })

    it('frees a slot when a request completes, so the next caller is served', async function () {
        const { server, gate, release } = buildServer({ limit: 1 })
        await listen(server)

        const parked = get(server, '/expensive', 1)
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap')

        assert.strictEqual((await get(server, '/expensive', 2)).status, 429)

        release()
        assert.strictEqual((await parked).status, 200)
        await waitFor(() => gate.getStats().in_flight === 0, 'slot to be released')

        assert.strictEqual((await get(server, '/expensive', 3)).status, 200)
        assert.strictEqual(gate.getStats().shed, 1)
    })

    it('frees a slot when the client aborts mid-request', async function () {
        // Without the 'close' leg an abandoned request keeps its slot forever
        // and the gate ratchets shut on a service that is doing nothing.
        const { server, gate } = buildServer({ limit: 1 })
        await listen(server)

        const controller = new AbortController()
        const aborted = get(server, '/expensive', 1, { signal: controller.signal })
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap')

        controller.abort()
        await aborted.catch(() => {})
        await waitFor(() => gate.getStats().in_flight === 0, 'aborted slot to be released')
    })

    it('still answers the /status readiness probe while the main gate sheds', async function () {
        const { server, gate } = buildServer({ limit: 1 })
        await listen(server)

        get(server, '/expensive', 1)
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap')

        // A healthcheck that 429s while the service sheds gets the container restarted.
        assert.strictEqual((await get(server, '/status', 2)).status, 200)
        assert.strictEqual((await get(server, '/expensive', 3)).status, 429)
    })

    it('bounds the probe reserve too, so /status is not an uncapped bypass', async function () {
        // /status is exempt from the MAIN cap, not from every cap: each call
        // makes an HTTP round-trip to the utxo-tracker, so an unbounded
        // exemption would just relocate the stampede onto the tracker.
        const { server, gate, probeGate, releaseProbe } = buildServer({
            limit: 10, probeLimit: 2, parkProbes: true
        })
        await listen(server)

        const parkedProbes = [get(server, '/status', 1), get(server, '/status', 2)]
        await waitFor(() => probeGate.getStats().in_flight === 2, 'probe reserve to fill')

        const overflow = await get(server, '/status', 3)
        assert.strictEqual(overflow.status, 429)
        assert.strictEqual((await overflow.json()).error.message, 'Server busy, retry shortly')
        assert.strictEqual(probeGate.getStats().shed, 1)

        // A saturated probe reserve must not consume the main capacity.
        assert.strictEqual(gate.getStats().in_flight, 0)

        releaseProbe()
        for(const response of await Promise.all(parkedProbes)) assert.strictEqual(response.status, 200)
    })

    it('is disabled by a cap of 0 (operator escape hatch)', async function () {
        const { server, gate, release, arrivals } = buildServer({ limit: 0 })
        await listen(server)

        const parked = [get(server, '/expensive', 1), get(server, '/expensive', 2), get(server, '/expensive', 3)]
        await waitFor(() => arrivals() === 3, 'all three requests to pass the disabled gate')

        // A disabled gate counts nothing and sheds nothing; it must not become a
        // cap of zero that refuses every request.
        assert.deepStrictEqual(gate.getStats(), { limit: 0, in_flight: 0, shed: 0 })

        release()
        for(const response of await Promise.all(parked)) assert.strictEqual(response.status, 200)
    })

    describe('resolveLimit', function () {

        it('keeps the caller default when the env var is unset or unparseable', function () {
            // A typo must not silently remove the cap.
            assert.strictEqual(resolveLimit(undefined, 50), 50)
            assert.strictEqual(resolveLimit('', 50), 50)
            assert.strictEqual(resolveLimit('lots', 50), 50)
        })

        it('honours an explicit value and treats <= 0 as disabled', function () {
            assert.strictEqual(resolveLimit('25', 50), 25)
            assert.strictEqual(resolveLimit('0', 50), 0)
            assert.strictEqual(resolveLimit('-5', 50), 0)
        })
    })

    describe('api.js wiring', function () {

        const fs        = require('fs')
        const path      = require('path')
        const apiSource = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8')

        it('mounts the gate on the app with an env-overridable cap', function () {
            assert.ok(apiSource.includes('concurrencyGate.createConcurrencyGate'))
            assert.ok(apiSource.includes('ENCODER_MAX_CONCURRENT_REQUESTS'))
            assert.ok(/app\.use\(requestGate\)/.test(apiSource))
        })

        it('mounts a bounded reserve for the exempt readiness probes', function () {
            assert.ok(apiSource.includes('ENCODER_MAX_CONCURRENT_PROBES'))
            assert.ok(/app\.use\(probeGate\)/.test(apiSource))
        })

        it('reports the gate stats so a stampede is visible to operators', function () {
            assert.ok(apiSource.includes('request_gate: requestGate.getStats()'))
            assert.ok(apiSource.includes('probe_gate: probeGate.getStats()'))
        })
    })
})
