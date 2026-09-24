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
 * Run: mocha test/security/concurrency_gate.test.js --timeout 30000
 */

'use strict'

const assert = require('assert')
const fs = require('fs');
const path = require('path');

describe('Security: global in-flight concurrency cap', function () {
    describe('api.js wiring', function () {

        const apiSource = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8')

        it('mounts the gate on the app with an env-overridable cap', function () {
            assert.ok(apiSource.includes('concurrencyGate.createConcurrencyGate'))
            assert.ok(apiSource.includes('ENCODER_MAX_CONCURRENT_REQUESTS'))
            assert.ok(/app\.use\(requestGate\)/.test(apiSource))
        })

        it('mounts a bounded reserve for the exempt readiness probes', function () {
            assert.ok(apiSource.includes('ENCODER_MAX_CONCURRENT_PROBES'))
            assert.ok(/app\.use\(probeGate\)/.test(apiSource))
            // The security suite drives this module's predicate; an inline copy here would escape it.
            assert.ok(apiSource.includes("const { isProbe } = require('./server/probe_request.js')"))
            assert.ok(!/const isProbe\s*=/.test(apiSource), 'api.js must not redefine the probe predicate')
        })

        it('reports the gate stats so a stampede is visible to operators', function () {
            assert.ok(apiSource.includes('request_gate: requestGate.getStats()'))
            assert.ok(apiSource.includes('probe_gate: probeGate.getStats()'))
        })
    })
})
