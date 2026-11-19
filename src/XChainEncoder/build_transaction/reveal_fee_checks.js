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
 * XChain Encoder - Encoder Class
 *
 * This file judges the fee a P2SH or P2WSH reveal actually pays once its outputs are final
 *
 ********************************************************************/

const TxSizeEstimator = require('../../build/tx_size_estimator')
const { logger, SATOSHI_UNIT, Encoding } = require('../constants.js')
const { jsonSafeSat, compactSizeLen } = require('../script_amount_helpers.js')
const { feeForVsize } = require('../fee_policy.js')
const { OperationalError } = require('../../build/errors.js')

// Whole-reveal size with and without the surplus sweep output, counting the caller's outputs.
function estimateRevealSizes(preparedData, customOutputs){
    let outputBytes = 0
    if (Array.isArray(customOutputs)) {
        for (const output of customOutputs) {
            outputBytes += TxSizeEstimator.estimateOutputSizeForAddress(output.address, this.network)
        }
    }
    const estimate = bytes => preparedData["encoding"] === Encoding.P2SH
        ? this.estimateP2shRevealTx(preparedData["dataBufferArray"], bytes)
        : this.estimateP2wshRevealTx(preparedData["dataBufferArray"], bytes)
    return { withSweep: estimate(outputBytes + 43), withoutSweep: estimate(outputBytes) }
}

// The legs are the reveal's only money, so its real fee is legs minus every emitted
// output. Below zero the transaction is invalid and below the relay minimum no node
// takes it, so either one is refused rather than returned for signing.
function assertRevealRelayFee(build, revealSize){
    const { phaseLegInputSatoshis, psbt, relayFeePerKb, softDustSurcharge } = build
    const outputs = psbt.txOutputs.reduce((sum, output) => sum + BigInt(output.value), 0n)
    const actualFee = phaseLegInputSatoshis - outputs
    const relayFeeBaseUnitsPerKb = Math.round(relayFeePerKb * SATOSHI_UNIT)
    const minimumRelayFee = Math.ceil(revealSize * relayFeeBaseUnitsPerKb / 1000) + (softDustSurcharge || 0)
    if (actualFee < 0n || actualFee < BigInt(minimumRelayFee)) {
        throw new OperationalError('REVEAL_LEGS_INSUFFICIENT',
            `reveal legs total ${phaseLegInputSatoshis} base units but outputs total ${outputs}, leaving fee ${actualFee}; ` +
            `the node relay minimum is ${minimumRelayFee} for a ~${revealSize}-byte reveal`,
            { legs: jsonSafeSat(phaseLegInputSatoshis), outputs: jsonSafeSat(outputs), actualFee: jsonSafeSat(actualFee), minimumRelayFee })
    }
    return actualFee
}

// The fee a reveal of `size` asks for at this call's rate, floored at the dust amount as
// the funding side floors it, or the caller's explicit fee, plus the soft-dust surcharge.
function wantedRevealFee(build, size){
    const { feePerBytes, requestedFee, softDustSurcharge } = build
    let base = Math.max(feeForVsize(size, feePerBytes, SATOSHI_UNIT), this.dustAmount)
    if (requestedFee != null && requestedFee > base) base = requestedFee
    return base + (softDustSurcharge || 0)
}

// Refuse an unrelayable reveal, then warn when it has no value output or pays less than
// it wanted. An outputless reveal is reported against the fee it would keep beside a sweep.
function judgeRevealFee(build, wantedFee, revealSize, outputlessFeeKept = wantedFee){
    const actualFee = assertRevealRelayFee.call(this, build, revealSize)
    const hasValueOutput = build.psbt.txOutputs.some(output => BigInt(output.value) > 0n)
    if (!hasValueOutput) noteUndersizedRevealLeg.call(this, build, outputlessFeeKept, actualFee, false)
    else if (actualFee < BigInt(wantedFee)) noteUndersizedRevealLeg.call(this, build, wantedFee, actualFee, true)
}

// 8-byte value, 1-byte length and a 22-byte P2WPKH script: the smallest standard output.
const SMALLEST_STANDARD_OUTPUT_BYTES = 31

// A single-chunk P2WSH reveal under the stripped floor is funded for a pad output in
// place of a sweep, so nothing on the reveal side sets its fee: it pays whatever the
// leg holds past the pad. Price the fee this call's rate asks for with the same estimate
// the funding side used. The commit priced the pad for its own change address, which
// the reveal may not share, so the pad is priced at the smallest output the commit could
// have funded: a change-type switch is not a rate shortfall. The relay check keeps the
// reveal's real size.
function judgePaddedRevealFee(build){
    const { preparedData, psbt, revealPadOutputIndex } = build
    let valueOutputBytes = 0
    let padSavingBytes = 0
    psbt.txOutputs.forEach((output, index) => {
        if (BigInt(output.value) <= 0n) return
        const bytes = 8 + compactSizeLen(output.script.length) + output.script.length
        valueOutputBytes += bytes
        if (index === revealPadOutputIndex) padSavingBytes = Math.max(0, bytes - SMALLEST_STANDARD_OUTPUT_BYTES)
    })
    const revealSize = this.estimateP2wshRevealTx(preparedData["dataBufferArray"], valueOutputBytes)
    const pricedSize = this.estimateP2wshRevealTx(preparedData["dataBufferArray"], valueOutputBytes - padSavingBytes)
    judgeRevealFee.call(this, build, wantedRevealFee.call(this, build, pricedSize), revealSize)
}

function noteUndersizedRevealLeg(build, revealFeeKept, actualFee, hasValueOutput){
    const { preparedData, phaseLegInputSatoshis, outputSatoshis } = build
    const legSatoshis = phaseLegInputSatoshis - outputSatoshis
    const encoding = preparedData["encoding"]
    const shortfall = hasValueOutput
        ? BigInt(revealFeeKept) - actualFee
        : BigInt(revealFeeKept) + BigInt(this.outputFloor) - legSatoshis
    const message = hasValueOutput
        ? `${encoding} reveal legs hold ${legSatoshis} base units after data outputs, but this reveal ` +
          `wants to keep ${revealFeeKept} as fee and can only pay ${actualFee}, a shortfall of ${shortfall}. ` +
          `It may confirm late or fail to confirm at the requested rate.`
        : `${encoding} reveal legs hold ${legSatoshis} base units after data outputs, ` +
          `but this reveal keeps ${revealFeeKept} as fee and needs an output floor of ${this.outputFloor}, ` +
          `a shortfall of ${shortfall}. The reveal has no value output, so every leg unit goes to fee and ` +
          `a signer that refuses full burns will refuse it. The commit may lack reveal headroom, or this ` +
          `reveal may be priced above the rate used to fund the commit.`
    logger.warn(`REVEAL_LEG_UNDERSIZED: ${message}`)
    build.revealLegUndersizedMessage = message
}

module.exports = { estimateRevealSizes, wantedRevealFee, judgeRevealFee, judgePaddedRevealFee }
