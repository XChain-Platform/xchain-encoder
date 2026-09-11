'use strict';

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
 * ONE tracker-freshness classifier.
 *
 * There is exactly one place the verdict is written. Split across two
 * endpoints, _buildTransaction reading the `sync` sibling on get_utxos and
 * api.js getServeReadiness() reading getSyncStatus(), each re-derives halted /
 * over-lag / behind-node / mempool-ready with its own strict-equality chain.
 * Two chains drift, and the drift shows up as a status board painting Online on
 * an encoder that refuses every create_tx.
 *
 * The first block pins the classifier's own behaviour. The second block is the
 * one that actually matters: it drives BOTH surfaces with the same payload and
 * asserts they reach the same verdict, so a future edit to one of them alone
 * goes red.
 *
 ********************************************************************/

// api.js constructs an encoder from env at load time; set the minimum viable
// env BEFORE requiring it, exactly as reg-10 does.
process.env.NETWORK = process.env.NETWORK || 'bitcoin-regtest'
process.env.NODE_URL = process.env.NODE_URL || '127.0.0.1'
process.env.NODE_PORT = process.env.NODE_PORT || '8332'
process.env.NODE_USER = process.env.NODE_USER || 'test'
process.env.NODE_PASSWORD = process.env.NODE_PASSWORD || 'test'

const assert = require('assert')
const XChainEncoder = require('../../src/XChainEncoder')
const { jsonRpcController, encoder: apiEncoder } = require('../../src/api')
const {
    TXID_A,
    makeUtxo,
    makeEncoder,
    getTestAddress
} = require('../integration/helpers/utxoFactory')

const classify = XChainEncoder.classifyTrackerFreshness

describe('classifyTrackerFreshness(): the single tracker-freshness verdict', function () {

    it('reports no refusal, and present:false, for a tracker with no freshness surface', function () {
        for (const absent of [undefined, null, 'not an object', 42]) {
            const v = classify(absent, 2)
            assert.strictEqual(v.code, null, 'a pre-freshness tracker must fail open')
            assert.strictEqual(v.present, false)
            assert.strictEqual(v.lag, null)
        }
    })

    it('refuses a halted tracker even at lag 0, and carries the halt reason', function () {
        const v = classify({ tracker_height: 100, node_height: 100, lag: 0, synced: true, halted: true,
            halt_reason: 'rolled back past the recovery window' }, 2)
        assert.strictEqual(v.code, 'UTXO_TRACKER_HALTED')
        assert.strictEqual(v.halted, true)
        assert.strictEqual(v.details.halt_reason, 'rolled back past the recovery window')
        assert.strictEqual(v.details.tracker_height, 100)
    })

    it('names the halt, not the staleness, when a halted tracker is ALSO stale', function () {
        // Ordering is load-bearing: a halt froze the tracker mid-rollback, and the
        // lag it froze at is a consequence, not the cause the operator needs.
        const v = classify({ lag: 99, synced: false, halted: true, mempool_ready: false }, 2)
        assert.strictEqual(v.code, 'UTXO_TRACKER_HALTED')
    })

    it('refuses a tracker that de-asserts synced, whatever the lag', function () {
        const v = classify({ tracker_height: 100, node_height: 100, lag: 0, synced: false }, 2)
        assert.strictEqual(v.code, 'UTXO_TRACKER_STALE')
        assert.strictEqual(v.details.lag, 0)
    })

    it('refuses a lag above the supplied ceiling and names the ceiling it used', function () {
        const v = classify({ lag: 7, synced: true }, 2)
        assert.strictEqual(v.code, 'UTXO_TRACKER_STALE')
        assert.strictEqual(v.overLag, true)
        assert.ok(/exceeds 2-block threshold/.test(v.message), v.message)
    })

    it('takes the ceiling from its argument, not from a baked-in constant', function () {
        // Same payload, two deployments: UTXO_TRACKER_MAX_LAG_BLOCKS moves the gate.
        assert.strictEqual(classify({ lag: 7, synced: true }, 2).code, 'UTXO_TRACKER_STALE')
        assert.strictEqual(classify({ lag: 7, synced: true }, 10).code, null)
    })

    it('serves at exactly the ceiling (lag == max is not "above")', function () {
        const v = classify({ lag: 2, synced: true }, 2)
        assert.strictEqual(v.code, null)
        assert.strictEqual(v.overLag, false)
    })

    it('refuses an orphaned view (tracker committed above the node) and says so', function () {
        const v = classify({ tracker_height: 1000, node_height: 900, lag: -100, synced: true }, 2)
        assert.strictEqual(v.code, 'UTXO_TRACKER_STALE')
        assert.strictEqual(v.behindNode, true)
        assert.ok(/orphaned/.test(v.message), v.message)
    })

    it('refuses a tracker whose mempool has not reconverged', function () {
        const v = classify({ lag: 0, synced: true, mempool_ready: false }, 2)
        assert.strictEqual(v.code, 'UTXO_TRACKER_NOT_READY')
        assert.strictEqual(v.mempoolReady, false)
    })

    it('fails open on every field it is not explicitly told is bad', function () {
        // An older tracker publishes lag/synced only. Nothing here is an explicit
        // negative, so nothing refuses; this is the property that let the gate ship
        // ahead of the fleet.
        const v = classify({ tracker_height: 100, node_height: 100, lag: 0, synced: true }, 2)
        assert.strictEqual(v.code, null)
        assert.strictEqual(v.halted, false)
        assert.strictEqual(v.mempoolReady, true)
    })

    it('treats a non-numeric lag as unknown rather than comparing it', function () {
        // A lag that is null, absent or a string bounds nothing; comparing it would
        // make `'7' > 2` decide whether money moves.
        for (const lag of [undefined, null, '7', NaN]) {
            const v = classify({ lag, synced: true }, 2)
            assert.strictEqual(v.overLag, false, `lag ${String(lag)} must not read as over-lag`)
            assert.strictEqual(v.behindNode, false)
            assert.strictEqual(v.lag, null)
            assert.strictEqual(v.code, null)
        }
    })

    it('separates the tracker\'s positive synced claim from the refusal verdict', function () {
        // The one real asymmetry between the two surfaces: a readiness probe needs a
        // POSITIVE assertion of health (an omitted `synced` is not one), while the
        // create_tx gate refuses only on an explicit negative.
        const omitted = classify({ lag: 0 }, 2)
        assert.strictEqual(omitted.syncedClaimed, false, 'an omitted synced is not an assertion')
        assert.strictEqual(omitted.code, null, 'but it is not an explicit negative either')
    })

    it('does not mutate the sync object it is handed', function () {
        const sync = { tracker_height: 100, node_height: 100, lag: 0, synced: true }
        const before = JSON.stringify(sync)
        classify(sync, 2)
        assert.strictEqual(JSON.stringify(sync), before)
    })
})

// The anti-drift test. Each row is one tracker state; both surfaces are driven
// with it and must agree. Before the shared classifier these two derivations
// lived 1200 lines apart and were edited independently.
const PARITY_CASES = [
    { name: 'healthy', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: true },
      expectCode: null },
    { name: 'lag at the ceiling', sync: { tracker_height: 98, node_height: 100, lag: 2, synced: true, mempool_ready: true },
      expectCode: null },
    { name: 'lag one over the ceiling', sync: { tracker_height: 97, node_height: 100, lag: 3, synced: true, mempool_ready: true },
      expectCode: 'UTXO_TRACKER_STALE' },
    { name: 'tracker de-asserts synced', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: false, mempool_ready: true },
      expectCode: 'UTXO_TRACKER_STALE' },
    { name: 'orphaned view', sync: { tracker_height: 1000, node_height: 900, lag: -100, synced: true, mempool_ready: true },
      expectCode: 'UTXO_TRACKER_STALE' },
    { name: 'halted', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: true, halted: true,
        halt_reason: 'unrecoverable reorg' },
      expectCode: 'UTXO_TRACKER_HALTED' },
    { name: 'mempool not reconverged', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: false },
      expectCode: 'UTXO_TRACKER_NOT_READY' }
]

describe('create_tx and health() reach the same verdict on the same tracker @regression', function () {

    async function createTxVerdict(sync) {
        const enc = makeEncoder('bitcoin-regtest')
        const address = getTestAddress('bitcoin-regtest')
        enc.utxoTrackerConnector.getUtxosFromAddress = async () => ({
            utxos: [makeUtxo('bitcoin-regtest', TXID_A, 0, 100000000)],
            sync
        })
        try {
            const result = await enc.createTransaction(
                null, address, null, 'test', null, 10000, false, null, address,
                null, null, null, true, 0.00001
            )
            assert.ok(result.psbt)
            return null
        } catch (err) {
            if (!err.operational) throw err
            return err.xchainCode
        }
    }

    async function healthVerdict(sync) {
        const orig = apiEncoder.utxoTrackerConnector.getSyncStatus
        apiEncoder.utxoTrackerConnector.getSyncStatus = async () => sync
        try {
            return await jsonRpcController.health()
        } finally {
            apiEncoder.utxoTrackerConnector.getSyncStatus = orig
        }
    }

    for (const testCase of PARITY_CASES) {
        it(`agrees on: ${testCase.name}`, async function () {
            const code = await createTxVerdict(testCase.sync)
            assert.strictEqual(code, testCase.expectCode,
                `create_tx verdict for "${testCase.name}"`)

            const health = await healthVerdict(testCase.sync)
            assert.strictEqual(health.tracker_synced, testCase.expectCode === null,
                `health() must read ${testCase.expectCode === null ? 'serveable' : 'un-serveable'} ` +
                `for "${testCase.name}", the same way create_tx does`)
        })
    }

    it('reports the halt and the mempool state alongside the verdict', async function () {
        const halted = await healthVerdict({ lag: 0, synced: true, halted: true, halt_reason: 'unrecoverable reorg' })
        assert.strictEqual(halted.tracker_halted, true)
        assert.strictEqual(halted.tracker_synced, false)

        const unready = await healthVerdict({ lag: 0, synced: true, mempool_ready: false })
        assert.strictEqual(unready.tracker_mempool_ready, false)
        assert.strictEqual(unready.tracker_synced, false)
    })
})
