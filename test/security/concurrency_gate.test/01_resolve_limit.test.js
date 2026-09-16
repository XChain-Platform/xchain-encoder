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
const { resolveLimit } = require('../../../src/server/concurrency_gate.js')

describe('Security: global in-flight concurrency cap', function () {
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
})
