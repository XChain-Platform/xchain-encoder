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
 * Security: probe variants Express routes to the probe handlers
 *
 * HEAD dispatches to the GET route, and default routing ignores case and a
 * trailing slash, so each variant must take its slot from the probe reserve.
 ********************************************************************/

'use strict'

const assert = require('assert')
const { PROBE_VARIANTS, isProbe, buildServer, listen, get, waitFor, closeServers } = require('../helpers/concurrency_gate_harness.js')

describe('Security: probe variants Express routes to the probe handlers', function () {
    afterEach(closeServers)

    it('classifies HEAD, trailing-slash and any-case probes, and nothing else', function () {
        for(const v of PROBE_VARIANTS){
            const req = { method: (v.init && v.init.method) || 'GET', path: v.path }
            assert.strictEqual(isProbe(req), true, v.label)
        }
        for(const req of [{ method: 'POST', path: '/status' }, { method: 'GET', path: '/statusx' },
            { method: 'GET', path: '/status/extra' }, { method: 'GET', path: '/' }]){
            assert.strictEqual(isProbe(req), false, req.method + ' ' + req.path)
        }
    })

    it('answers every variant from the probe reserve while the main gate sheds', async function () {
        const { server, gate, probeGate } = buildServer({ limit: 1 })
        await listen(server)

        get(server, '/expensive', 1)
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap')

        let ip = 2
        for(const v of PROBE_VARIANTS){
            const res = await get(server, v.path, ip++, v.init)
            assert.strictEqual(res.status, 200, v.label + ' must not be shed by the main cap')
        }
        assert.strictEqual(gate.getStats().shed, 0)
        assert.strictEqual(probeGate.getStats().shed, 0)
    })

    it('holds the probe-reserve slot of an aborted HEAD /status until its handler settles', async function () {
        const { server, probeGate, releaseProbe, enteredProbe } = buildServer({
            limit: 10, probeLimit: 1, parkProbes: true
        })
        await listen(server)

        const controller = new AbortController()
        const aborted = get(server, '/status', 1, { method: 'HEAD', signal: controller.signal })
        await waitFor(() => probeGate.getStats().in_flight === 1, 'HEAD probe to take a reserve slot')
        await waitFor(() => enteredProbe() === 1, 'the probe handler to have entered')

        controller.abort()
        await aborted.catch(() => {})
        // Deliberate delay, not a sync point: the claim is that in_flight STAYS 1.
        await new Promise(r => setTimeout(r, 50))
        assert.strictEqual(probeGate.getStats().in_flight, 1)

        releaseProbe()
        await waitFor(() => probeGate.getStats().in_flight === 0, 'slot to come back once the probe settled')
    })
})
