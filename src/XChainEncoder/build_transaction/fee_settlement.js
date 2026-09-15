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
 * This file handles starting the encoder and generating transactions
 * 
 ********************************************************************/

const util = require('node:util');
const { OperationalError } = require('../../build/errors')
const { logger, SATOSHI_UNIT, RESERVATION_TTL_MS } = require('../constants.js')
const { jsonSafeSat } = require('../script_amount_helpers.js')
const { maxCpfpUpliftSat, packageFeeUpliftSatoshis } = require('../fee_policy.js')

// The caller-fee ceilings: the rate cap, then the absolute burn backstop.
function refuseExcessiveFee(build){
    let { fee, capFeePerBytes, estimatedTxSize, estimatedFee, nodeFeePerBytes, feePerBytes } = build
    // Reject a caller-supplied absolute fee whose effective rate exceeds the
    // fee-rate cap for a transaction of this estimated size. Unlike feePerKb
    // (clamped above), an explicit fee is an exact amount the caller believes
    // they are paying. Silently lowering it would change what they sign, so
    // refuse loudly instead. Without this, fee values up to the gross
    // validator limit drain every selected input into miner fee.
    if (fee != null && fee !== false && capFeePerBytes != null){
        const maxFeeSatoshis = Math.max(this.dustAmount, Math.ceil(estimatedTxSize * capFeePerBytes * SATOSHI_UNIT))
        if (estimatedFee > maxFeeSatoshis){
            throw new RangeError(`fee ${estimatedFee} exceeds the maximum allowed ${maxFeeSatoshis} satoshis for a ~${estimatedTxSize}-byte transaction (fee-rate cap)`)
        }
    }

    // Absolute burn backstop that holds even when the operator disables the
    // rate cap (capFeePerBytes == null) and even when a change address is
    // supplied (which skips the burn guard below). An explicit fee above 100x
    // the node-derived fair fee for this size is almost certainly an error that
    // would drain every selected input to the miner, so refuse it. 100x matches
    // the default MAX_FEE_RATE_MULTIPLIER, so default deployments are unaffected.
    //
    // The fair-fee reference is the NODE's rate (nodeFeePerBytes), never the
    // caller-supplied feePerKb: deriving the ceiling from feePerBytes let a
    // caller inflate feePerKb to lift the ceiling with it, bypassing the
    // backstop entirely whenever the rate cap was disabled. feePerBytes is
    // used only as a last resort when the node can produce neither an
    // estimate nor a relayfee (same graceful degradation as the relative
    // cap, and the caller cannot cause that condition).
    if (fee != null && fee !== false){
        const referenceFeePerBytes = nodeFeePerBytes != null ? nodeFeePerBytes : feePerBytes
        if (referenceFeePerBytes != null){
            const fairFee = Math.ceil(estimatedTxSize * referenceFeePerBytes * SATOSHI_UNIT)
            const hardCeiling = Math.max(this.dustAmount, fairFee * 100)
            if (estimatedFee > hardCeiling){
                throw new RangeError(`fee ${estimatedFee} exceeds 100x the estimated fair fee (${fairFee} satoshis) for a ~${estimatedTxSize}-byte transaction`)
            }
        }
    }
}

async function upliftForAncestors(build){
    let { unconfirmedInputTxids, feePerBytes, estimatedFee, estimatedTxSize } = build
    // CPFP-aware package sizing.
    //
    // A miner fills a block by ANCESTOR fee rate, so a transaction spending
    // unconfirmed inputs is only mined when its whole mempool package clears
    // the target. Paying the target on this transaction's own bytes is not
    // enough: a PRICE batch paying 0.01017 DOGE/kB sat unmined because its
    // funding ancestors pay 0.00313 DOGE/kB, putting the package at 0.00896,
    // under Dogecoin's 0.01 DOGE/kB inclusion floor. Those inputs do not
    // signal RBF, so the fee cannot be replaced afterwards; it has to be
    // right at build time. Lift this fee to carry the package instead.
    //
    // Placed after the caller-fee checks above so the caller's own fee is
    // still judged as supplied, and every ceiling those checks enforce is
    // re-applied here to the uplifted total. Any failure at all (no ancestor
    // data, an unreachable node, a connector without the method) leaves the
    // per-transaction fee exactly as it was.
    const cpfpUpliftBound = maxCpfpUpliftSat()
    // Whatever unconfirmed ancestors this transaction inherits, carried out of
    // the block below so the two-phase prefund pass can price the reveal
    // against the WHOLE chain (ancestors + commit + reveal), not just against
    // the commit. They stay 0 when nothing was measured.
    let commitAncestorSize = 0
    let commitAncestorFeeSat = 0
    if (unconfirmedInputTxids.length > 0 && feePerBytes > 0 && cpfpUpliftBound > 0 &&
        this.connector && typeof this.connector.getUnconfirmedAncestorPackage === 'function'){
        let ancestorPackage = null
        try {
            ancestorPackage = await this.connector.getUnconfirmedAncestorPackage(unconfirmedInputTxids)
        } catch (err) {
            logger.warn(util.format('Package fee sizing skipped: ancestor lookup failed:', err.message))
        }
        if (ancestorPackage && Number.isFinite(Number(ancestorPackage.size)) && Number(ancestorPackage.size) > 0){
            commitAncestorSize = Number(ancestorPackage.size)
            commitAncestorFeeSat = Math.round(Number(ancestorPackage.fees) * SATOSHI_UNIT)
            if (!Number.isFinite(commitAncestorFeeSat) || commitAncestorFeeSat < 0){
                commitAncestorSize = 0
                commitAncestorFeeSat = 0
            }
        }
        const wanted = ancestorPackage ? packageFeeUpliftSatoshis({
            currentFee: estimatedFee,
            txSize: estimatedTxSize,
            ancestorSize: ancestorPackage.size,
            ancestorFees: ancestorPackage.fees,
            targetFeePerBytes: feePerBytes,
            satoshiUnit: SATOSHI_UNIT
        }) : 0

        if (wanted > 0){
                estimatedFee = upliftAncestorFee.call(this, build, ancestorPackage, wanted, cpfpUpliftBound)
        }
    }
    Object.assign(build, { cpfpUpliftBound, commitAncestorSize, commitAncestorFeeSat, estimatedFee })
}

// The ancestor uplift actually applied, bounded by every ceiling and by the inputs.
function upliftAncestorFee(build, ancestorPackage, wanted, cpfpUpliftBound){
    let { capFeePerBytes, estimatedTxSize, estimatedFee, nodeFeePerBytes, feePerBytes, p2shHash, inputSatoshis,
        outputSatoshis, unconfirmedInputTxids } = build
// Its own absolute bound first: the uplift buys ancestor bytes, and
// the rate caps below only ever measure a fee against THIS
// transaction's size.
let allowed = Math.min(wanted, cpfpUpliftBound)

if (capFeePerBytes != null){
    const maxFeeSatoshis = Math.max(this.dustAmount, Math.ceil(estimatedTxSize * capFeePerBytes * SATOSHI_UNIT))
    allowed = Math.min(allowed, maxFeeSatoshis - estimatedFee)
}

const referenceFeePerBytes = nodeFeePerBytes != null ? nodeFeePerBytes : feePerBytes
if (referenceFeePerBytes != null){
    const fairFee = Math.ceil(estimatedTxSize * referenceFeePerBytes * SATOSHI_UNIT)
    allowed = Math.min(allowed, Math.max(this.dustAmount, fairFee * 100) - estimatedFee)
}

// Never spend an input that is not there. Without this bound a
// package uplift would turn a fundable build into INSUFFICIENT_FUNDS,
// which is a worse outcome than a transaction that confirms late.
if (!p2shHash){
    const headroom = inputSatoshis - outputSatoshis - BigInt(estimatedFee)
    if (headroom <= 0n) allowed = 0
    else if (allowed > 0 && headroom < BigInt(allowed)) allowed = Number(headroom)
}

if (allowed < 0) allowed = 0

if (allowed < wanted){
    const packageSize = ancestorPackage.size + estimatedTxSize
    const packageFee = Math.round(ancestorPackage.fees * SATOSHI_UNIT) + estimatedFee + allowed
    logger.warn(`Package fee uplift clamped to ${allowed} of ${wanted} base units: this transaction ` +
        `spends ${unconfirmedInputTxids.length} unconfirmed input(s) whose ancestors total ` +
        `${ancestorPackage.size} bytes. The package will pay ${Math.round(packageFee / packageSize * 1000)} ` +
        `base units/kB against a target of ${Math.round(feePerBytes * SATOSHI_UNIT * 1000)}, so it may ` +
        `stay unmined. Raise MAX_CPFP_UPLIFT_SAT, MAX_FEE_RATE_KB or the input balance to close the gap.`)
}

if (allowed > 0){
    estimatedFee = estimatedFee + allowed
}
    return estimatedFee
}

function floorEstimatedFee(build){
    let { estimatedFee } = build
    if (estimatedFee < this.dustAmount){
        estimatedFee = this.dustAmount
    }
    Object.assign(build, { estimatedFee })
}

function prefundRevealPackage(build){
    let { revealPrefund, p2shHash, feePerBytes, cpfpUpliftBound, estimatedTxSize, commitAncestorSize, estimatedFee,
        commitAncestorFeeSat } = build
    // Two-phase package prefund.
    //
    // A reveal spends nothing but the commit's own outputs, so the two are
    // ALWAYS one mempool package and the miner judges them on the package's
    // ancestor fee rate. The reveal's fee is money the commit set aside, and
    // the reveal has no other input to raise it from, so a commit that ends
    // up under the target rate drags the whole package under it and the
    // reveal cannot rescue itself: the pair sits unmined with a confirmed
    // commit stranded behind it. This is the shape a PRICE batch publish
    // takes, and the commit lands under target whenever the caller supplies
    // an explicit fee below the node's rate, or its own CPFP uplift was
    // clamped (see the warning above), or its size estimate ran short.
    //
    // So prefund the reveal at the PACKAGE rate rather than at its own: the
    // reveal carries the commit's shortfall, plus the shortfall of whatever
    // unconfirmed ancestors the commit inherits. The money comes out of
    // change, not out of thin air, and the commit's own fee is untouched -
    // the pair's total is what a miner weighs, and only the reveal can still
    // be raised at this point.
    //
    // This cannot live in the emission branch that sized the commit output:
    // input selection, the caller-fee ceilings and the CPFP uplift all run
    // after it, and the commit's fee and size are only final here.
    if (revealPrefund && !p2shHash && feePerBytes > 0 && cpfpUpliftBound > 0){
        const wanted = packageFeeUpliftSatoshis({
            currentFee: revealPrefund.revealFee,
            txSize: revealPrefund.revealSize,
            ancestorSize: estimatedTxSize + commitAncestorSize,
            ancestorFeeSatoshis: estimatedFee + commitAncestorFeeSat,
            targetFeePerBytes: feePerBytes,
            satoshiUnit: SATOSHI_UNIT
        })

        if (wanted > 0){
                applyRevealPrefund.call(this, build, wanted)
        }
    }
}

// Moves the bounded prefund into the commit output that carries the reveal's fee.
function applyRevealPrefund(build, wanted){
    let { cpfpUpliftBound, inputSatoshis, outputSatoshis, estimatedFee, commitAncestorSize, estimatedTxSize,
        revealPrefund, commitAncestorFeeSat, feePerBytes, psbt, envelopeContext } = build
// The same absolute bound the single-tx uplift answers to: this
// buys someone else's bytes, so no rate cap measured against one
// transaction's size can bound it.
let allowed = Math.min(wanted, cpfpUpliftBound)

// Never spend an input that is not there. The prefund is paid out
// of change, so it is bounded by what change actually holds;
// turning a fundable build into INSUFFICIENT_FUNDS would be a
// worse outcome than a package that confirms late.
const headroom = inputSatoshis - outputSatoshis - BigInt(estimatedFee)
if (headroom <= 0n) allowed = 0
else if (headroom < BigInt(allowed)) allowed = Number(headroom)
if (allowed < 0) allowed = 0

if (allowed < wanted){
    const packageSize = commitAncestorSize + estimatedTxSize + revealPrefund.revealSize
    const packageFee = commitAncestorFeeSat + estimatedFee + revealPrefund.revealFee + allowed
    logger.warn(`Reveal package prefund clamped to ${allowed} of ${wanted} base units: this commit ` +
        `pays ${estimatedFee} base units over ~${estimatedTxSize} bytes, so the commit/reveal package ` +
        `will pay ${Math.round(packageFee / packageSize * 1000)} base units/kB against a target of ` +
        `${Math.round(feePerBytes * SATOSHI_UNIT * 1000)}. The reveal cannot raise its own fee later, ` +
        `so the pair may stay unmined. Raise MAX_CPFP_UPLIFT_SAT, the commit's fee, or the input balance.`)
}

if (allowed > 0){
    this.raiseOutputValue(psbt, revealPrefund.outputIndex, allowed)
    outputSatoshis = outputSatoshis + BigInt(allowed)
    revealPrefund.revealFee = revealPrefund.revealFee + allowed
    // The envelope reveal is built in THIS call against these two
    // numbers, so both have to move with the output or its change
    // output would silently hand the uplift back to the caller.
    if (envelopeContext){
        envelopeContext.commitValue = envelopeContext.commitValue + allowed
        envelopeContext.revealFee = envelopeContext.revealFee + allowed
    }
}
    Object.assign(build, { outputSatoshis })
}

function computeChange(build){
    let { estimatedFee, inputSatoshis, outputSatoshis, p2shHash, reservedCandidates, change } = build
    // Validate the fee BEFORE the BigInt conversion below: BigInt(estimatedFee)
    // throws an opaque error on a NaN/Infinity fee, where this check names the cause.
    if (!Number.isFinite(estimatedFee) || !Number.isInteger(estimatedFee)) {
        throw new RangeError('Fee calculation produced invalid result. Check that all UTXO values and fees are valid integers.')
    }

    // Exact change math in BigInt: with a >2^53-1-sat input, Number
    // subtraction would round the change (and the caller would sign a
    // PSBT whose change is off by up to ~2 sats per 2^53).
    let changeSatoshis = inputSatoshis - outputSatoshis - BigInt(estimatedFee)

    // Reject a genuinely under-funded selection instead of returning an
    // unbroadcastable PSBT whose outputs exceed its inputs (the caller would
    // sign it and the network would reject it). Scoped to the funding/single
    // tx path: the reveal (p2shHash set) funds itself from phase-1 outputs
    // and never runs input selection, so inputSatoshis is 0 there by design
    // and a negative "change" is expected and harmless.
    if (!p2shHash && changeSatoshis < 0) {
        const required = outputSatoshis + BigInt(estimatedFee)
        // Name the reserved candidates when there were any: the shortfall then
        // comes from inputs another build of the last RESERVATION_TTL_MS still
        // holds, not from an under-funded address, and the caller's fix is to
        // broadcast that build or wait, not to fund the address. Found live on
        // TDOGE: two spendable outputs plus dust, two un-broadcast
        // builds, and the third build reported the dust output as the whole
        // balance, which the wallet rendered as "not enough funds". Same
        // wording as the zero-selected branch above so one reader handles both.
        const held = reservedCandidates > 0
            ? `; ${reservedCandidates} candidate input(s) are reserved by a transaction built in the last ` +
              `${Math.round(RESERVATION_TTL_MS / 60000)} minutes; broadcast that transaction or wait for the reservation to lapse`
            : ''
        throw new OperationalError(
            'INSUFFICIENT_FUNDS',
            `insufficient funds: selected inputs total ${inputSatoshis} but ${required} is required (outputs ${outputSatoshis} + fee ${estimatedFee})${held}`,
            { required: jsonSafeSat(required), available: jsonSafeSat(inputSatoshis), outputs: jsonSafeSat(outputSatoshis), fee: estimatedFee, reservedCandidates }
        )
    }

    if ((changeSatoshis > this.dustAmount) && !change) {
        throw new OperationalError('CHANGE_ADDRESS_REQUIRED', 'Transaction would burn significant satoshis as fees. Please provide a change address.')
    }
    Object.assign(build, { changeSatoshis })
}

module.exports = { refuseExcessiveFee, upliftForAncestors, floorEstimatedFee, prefundRevealPackage, computeChange }
