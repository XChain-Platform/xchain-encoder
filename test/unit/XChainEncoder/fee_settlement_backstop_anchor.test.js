// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const { backstopReferenceFeePerBytes } = require('../../../src/XChainEncoder/fee_policy.js')
const { refuseExcessiveFee, upliftForAncestors } = require('../../../src/XChainEncoder/build_transaction/fee_settlement.js')

function explicitFeeBuild(overrides = {}){
    return Object.assign({
        fee: 1000000,
        capFeePerBytes: null,
        estimatedTxSize: 100,
        nodeFeePerBytes: null,
        relayFeePerKb: 0.00001,
        feePerBytes: 1,
        estimatedFee: 1000000,
        softDustSurcharge: 0
    }, overrides)
}

async function applyAncestorUplift(build){
    const iterator = upliftForAncestors.call({
        dustAmount: 1,
        connector: { getUnconfirmedAncestorPackage: async () => ({ size: 100, fees: 0 }) }
    }, build)
    let step = iterator.next()
    while (!step.done) step = iterator.next(await step.value)
}

function ancestorBuild(overrides = {}){
    return Object.assign({
        unconfirmedInputTxids: ['a'.repeat(64)],
        feePerBytes: 1,
        estimatedFee: 100,
        estimatedTxSize: 100,
        capFeePerBytes: null,
        nodeFeePerBytes: null,
        relayFeePerKb: 0.00001,
        p2shHash: true
    }, overrides)
}

describe('fee burn backstop reference', function () {
    it('prefers the node estimate, falls back to relayfee, and never uses the caller rate', function () {
        assert.strictEqual(backstopReferenceFeePerBytes({ nodeFeePerBytes: 2e-8, relayFeePerKb: 0.00001 }), 2e-8)
        assert.strictEqual(backstopReferenceFeePerBytes({ nodeFeePerBytes: null, relayFeePerKb: 0.00001 }), 1e-8)
        assert.strictEqual(backstopReferenceFeePerBytes({ nodeFeePerBytes: null, relayFeePerKb: 0 }), null)
        assert.strictEqual(backstopReferenceFeePerBytes({ nodeFeePerBytes: null, relayFeePerKb: null }), null)
    })

    it('anchors an explicit-fee refusal on relayfee instead of the caller rate', function () {
        assert.throws(() => refuseExcessiveFee.call({ dustAmount: 1 }, explicitFeeBuild()),
            (err) => err instanceof RangeError && /100x the estimated fair fee/.test(err.message))
    })

    it('fails closed with a plain error when no node-derived anchor exists', function () {
        assert.throws(() => refuseExcessiveFee.call({ dustAmount: 1 }, explicitFeeBuild({ relayFeePerKb: null })),
            (err) => !(err instanceof RangeError) && /cannot be anchored/.test(err.message))
    })

    it('bounds an ancestor uplift by relayfee instead of the caller rate', async function () {
        const build = ancestorBuild()
        await applyAncestorUplift(build)
        assert.strictEqual(build.estimatedFee, 10000)
    })

    it('skips an ancestor uplift when no node-derived anchor exists', async function () {
        const build = ancestorBuild({ relayFeePerKb: null })
        await applyAncestorUplift(build)
        assert.strictEqual(build.estimatedFee, 100)
    })
})
