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
const { refuseExcessiveActualFee } = require('../../../src/XChainEncoder/build_transaction/actual_fee_guard.js')

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

function actualFeeBuild(overrides = {}){
    return Object.assign({
        fee: 546,
        capFeePerBytes: null,
        estimatedTxSize: 267,
        nodeFeePerBytes: 1e-8,
        relayFeePerKb: 0.00001,
        softDustSurcharge: 0,
        inputSatoshis: 1000000n,
        changeSatoshis: 989454n,
        psbt: { txOutputs: [{ value: 10000n }] }
    }, overrides)
}

function rateCappedActualBuild(overrides = {}){
    return actualFeeBuild(Object.assign({
        fee: null,
        feePerKb: 20000,
        capFeePerBytes: 2e-7,
        nodeFeePerBytes: 2e-8,
        estimatedTxSize: 200,
        inputSatoshis: 1000000n,
        changeSatoshis: 30000n,
        psbt: { txOutputs: [{ value: 966000n }] }
    }, overrides))
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

describe('actual emitted fee backstop', function () {
    it('refuses sub-floor change that would exceed the burn ceiling', function () {
        assert.throws(
            () => refuseExcessiveActualFee.call({ dustAmount: 546, outputFloor: 1000000 }, actualFeeBuild()),
            (err) => err.xchainCode === 'CHANGE_BELOW_OUTPUT_FLOOR' && err.details.actualFee === 990000
        )
    })

    it('allows the same transaction when its change was emitted', function () {
        const build = actualFeeBuild({ psbt: { txOutputs: [{ value: 10000n }, { value: 989454n }] } })
        assert.doesNotThrow(
            () => refuseExcessiveActualFee.call({ dustAmount: 546, outputFloor: 1000000 }, build)
        )
    })

    it('applies the explicit fee-rate cap to the actual fee', function () {
        const build = actualFeeBuild({ capFeePerBytes: 0.000001, nodeFeePerBytes: 0.001 })
        assert.throws(
            () => refuseExcessiveActualFee.call({ dustAmount: 546, outputFloor: 1000000 }, build),
            (err) => err.xchainCode === 'CHANGE_BELOW_OUTPUT_FLOOR' && /fee-rate cap/.test(err.message)
        )
    })

    it('allows normal DOGE soft-dust folding below the burn ceiling', function () {
        const build = actualFeeBuild({
            fee: null,
            estimatedTxSize: 250,
            nodeFeePerBytes: 0.00001,
            inputSatoshis: 1000000n,
            changeSatoshis: 900000n,
            psbt: { txOutputs: [{ value: 100000n }] }
        })
        assert.doesNotThrow(
            () => refuseExcessiveActualFee.call({
                dustAmount: 100000,
                outputFloor: 1000000,
                networkKey: 'dogecoin-regtest'
            }, build)
        )
    })

    it('leaves reveal spends to their warn-only fee checks', function () {
        assert.doesNotThrow(() => refuseExcessiveActualFee.call(
            { dustAmount: 546, outputFloor: 1000000 },
            actualFeeBuild({ p2shHash: 'commit', psbt: null })
        ))
    })
})

describe('actual emitted fee rate cap', function () {
    it('applies the fee-rate cap to a feePerKb-priced actual fee', function () {
        assert.throws(
            () => refuseExcessiveActualFee.call(
                { dustAmount: 546, outputFloor: 50000 }, rateCappedActualBuild()),
            (err) => err.xchainCode === 'CHANGE_BELOW_OUTPUT_FLOOR' && /fee-rate cap/.test(err.message)
        )
    })

    it('applies the fee-rate cap to a node-priced actual fee', function () {
        const build = rateCappedActualBuild({ feePerKb: null })
        assert.throws(
            () => refuseExcessiveActualFee.call({ dustAmount: 546, outputFloor: 50000 }, build),
            (err) => err.xchainCode === 'CHANGE_BELOW_OUTPUT_FLOOR' && /fee-rate cap/.test(err.message)
        )
    })

    it('uses only the burn ceiling when the fee-rate cap is disabled', function () {
        const build = rateCappedActualBuild({ capFeePerBytes: null })
        assert.doesNotThrow(
            () => refuseExcessiveActualFee.call({ dustAmount: 546, outputFloor: 50000 }, build)
        )
    })

    it('allows a feePerKb-priced actual fee at the rate ceiling', function () {
        const build = rateCappedActualBuild({
            changeSatoshis: 3000n,
            psbt: { txOutputs: [{ value: 996000n }] }
        })
        assert.doesNotThrow(
            () => refuseExcessiveActualFee.call({ dustAmount: 546, outputFloor: 50000 }, build)
        )
    })
})
