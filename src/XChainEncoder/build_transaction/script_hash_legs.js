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

const bitcoin = require('bitcoinjs-lib');
const TxSizeEstimator = require('../../build/tx_size_estimator')
const { MAGIC_WORD, SATOSHI_UNIT } = require('../constants.js')
const { asSatValue } = require('../script_amount_helpers.js')
const { assertRevealFundingTxMatches } = require('../request_resolution.js')

// A P2SH chunk: a funding output on the commit, or an input spending it on the reveal.
function* emitP2shChunk(build, nextDataBuffer){
    let { p2shHex, p2shTx, txidFirstInput, p2shHash } = build
    if (p2shHex && !p2shTx){
        p2shTx = bitcoin.Transaction.fromHex(p2shHex)
        txidFirstInput = p2shTx.getId()
        assertRevealFundingTxMatches(p2shHash, txidFirstInput)
    }
    Object.assign(build, { p2shTx, txidFirstInput })

    if (p2shHash){
        yield* spendP2shLeg.call(this, build, nextDataBuffer)
    } else {
        fundP2shLeg.call(this, build, nextDataBuffer)
    }
}

function* spendP2shLeg(build, nextDataBuffer){
    let { psbt, txidFirstInput, estimatedTxSize, p2shTx, voutPsbtIndex, utxoSequence, p2shHash, p2shHex, phaseLegInputSatoshis } = build
    if (!psbt){
        let opReturnData = yield this.obfuscate(
            Buffer.concat([
                Buffer.from(MAGIC_WORD,'utf8'),
                Buffer.from("p2sh",'utf8')
            ]),
            txidFirstInput
        )

        psbt = new bitcoin.Psbt({ network: this.network })
        psbt.addOutput({
            script: bitcoin.payments.embed({
                data: [opReturnData]
            }).output,
            value: 0
        })

        estimatedTxSize = estimatedTxSize
            + TxSizeEstimator.estimateOpReturnOutput(opReturnData)
    }

    if (!p2shTx || !p2shTx.outs || voutPsbtIndex >= p2shTx.outs.length) {
        throw new RangeError(`p2shHex transaction does not have output at index ${voutPsbtIndex}`)
    }
    let nextInput = {
        sequence: utxoSequence,
        hash:p2shHash,
        redeemScript:nextDataBuffer,
        index: voutPsbtIndex,
        nonWitnessUtxo:Buffer.from(p2shHex, 'hex')
    }

    psbt.addInput(nextInput)
    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
    // Leg value this reveal input consumes; the surplus sweep
    // after the emission loop needs the total to price the
    // change output.
    phaseLegInputSatoshis = phaseLegInputSatoshis + BigInt(p2shTx.outs[voutPsbtIndex].value)

    voutPsbtIndex = voutPsbtIndex + 1
    Object.assign(build, { psbt, estimatedTxSize, phaseLegInputSatoshis, voutPsbtIndex })
}

function fundP2shLeg(build, nextDataBuffer){
    let { feePerBytes, finalDust, revealCustomOutputsValue, revealCustomOutputsFee, psbt, outputSatoshis, estimatedTxSize } = build
    let spendingP2shEstimatedSize = this.estimateSpendingP2shTx(nextDataBuffer)
    let spendingP2shEstimatedFee = Math.trunc((spendingP2shEstimatedSize * feePerBytes) * SATOSHI_UNIT)

    if (spendingP2shEstimatedFee < finalDust){
        spendingP2shEstimatedFee = finalDust
    }

    // Over-fund the first funding output by the reveal-side
    // customOutputs total, plus the miner fee for the bytes
    // they add to the reveal, so the reveal can pay them
    // (consumed once).
    if (revealCustomOutputsValue > 0n || revealCustomOutputsFee > 0){
        spendingP2shEstimatedFee = asSatValue(BigInt(spendingP2shEstimatedFee) + revealCustomOutputsValue + BigInt(revealCustomOutputsFee))
        revealCustomOutputsValue = 0n
        revealCustomOutputsFee = 0
    }

    spendingP2shEstimatedFee = topUpFirstP2shLeg.call(this, build, spendingP2shEstimatedFee)

    psbt.addOutput({
        address: bitcoin.payments.p2sh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
        value:spendingP2shEstimatedFee
    })

    outputSatoshis = outputSatoshis + BigInt(spendingP2shEstimatedFee)

    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateP2shOutput()
    Object.assign(build, { revealCustomOutputsValue, revealCustomOutputsFee, outputSatoshis, estimatedTxSize })
}

function topUpFirstP2shLeg(build, spendingP2shEstimatedFee){
    let { p2shRevealHeadroomFunded, revealCustomOutputsBytes, preparedData, feePerBytes, finalDust, psbt, revealPrefund } = build
    // The reveal's ONLY inputs are these
    // funding legs (the reveal path runs no input selection),
    // so every satoshi the reveal spends - its miner fee AND
    // any output it leaves - must be prefunded here. Sizing
    // each leg at max(per-chunk fee share, dust floor) alone
    // left the reveal unable to leave a single output on
    // Dogecoin, where the dust floor (100000 koinu) is the
    // whole leg and the reveal's own required fee consumes
    // it: the SDK's FULL_BURN_FEE guard then (correctly)
    // refused to sign and the confirmed phase-1 commit was
    // stranded. Top the FIRST leg up (consumed once, like
    // the customOutputs fold above) so the legs total covers
    // the whole reveal's fee AS THE REVEAL ITSELF WILL PRICE
    // IT (estimateP2shRevealTx, shared by both phases), plus
    // one dust (this.dustAmount, the same constant the
    // reveal-side sweep compares against) for the change
    // output the reveal returns to the caller. The 43 is the
    // same worst-case change-output size constant the
    // single-tx path reserves below.
    //
    // That change output is needed ONLY when the reveal would
    // otherwise emit no value output at all. A reveal already
    // carrying customOutputs (the native protocol fee) leaves
    // value by definition, so the burn guard is satisfied and
    // funding a change output too would buy the caller a
    // third output they did not ask for - which is what REG-14
    // pins against on the legacy-fee-output case. So the fee
    // base keeps the 43-byte change slot either way - both
    // shapes stay priced identically, which is the other half
    // REG-14 pins - and only the dust that would make a change
    // output emittable is conditional. With customOutputs the
    // surplus then lands at zero, below the sweep's dust
    // threshold, and the reveal keeps exactly its two outputs.
    if (!p2shRevealHeadroomFunded){
        p2shRevealHeadroomFunded = true
        let needsChangeOutput = (revealCustomOutputsBytes === 0)
        let { baseLegsTotal, revealFeeNeeded } = sumP2shRevealLegs.call(this, preparedData, feePerBytes, finalDust)
        let revealShortfall = Math.max(0, revealFeeNeeded - baseLegsTotal)
        // The reveal's change is an authored output, so its headroom is the relay floor.
        let changeHeadroom = needsChangeOutput ? BigInt(this.outputFloor) : 0n
        spendingP2shEstimatedFee = asSatValue(BigInt(spendingP2shEstimatedFee) + BigInt(revealShortfall) + changeHeadroom)
        // This leg is where the reveal's fee money lives, so it is
        // the one the package-prefund pass tops up.
        revealPrefund = {
            outputIndex: psbt.txOutputs.length,
            revealSize: this.estimateP2shRevealTx(preparedData["dataBufferArray"], 43),
            revealFee: revealFeeNeeded
        }
    }
    Object.assign(build, { p2shRevealHeadroomFunded, revealPrefund })
    return spendingP2shEstimatedFee
}

// What the legs fund at their own per-chunk sizing, and what the whole reveal needs.
function sumP2shRevealLegs(preparedData, feePerBytes, finalDust){
    let baseLegsTotal = 0
    for (const chunkBuffer of preparedData["dataBufferArray"]){
        let chunkLegFee = Math.trunc((this.estimateSpendingP2shTx(chunkBuffer) * feePerBytes) * SATOSHI_UNIT)
        baseLegsTotal = baseLegsTotal + Math.max(chunkLegFee, finalDust)
    }
    let revealFeeNeeded = Math.trunc((this.estimateP2shRevealTx(preparedData["dataBufferArray"], 43) * feePerBytes) * SATOSHI_UNIT)
    if (revealFeeNeeded < this.dustAmount){
        // Mirrors the reveal path's own dust floor on
        // estimatedFee, so both phases price the same fee.
        revealFeeNeeded = this.dustAmount
    }
    return { baseLegsTotal, revealFeeNeeded }
}

// A P2WSH chunk: a funding output on the commit, or an input spending it on the reveal.
function* emitP2wshChunk(build, nextDataBuffer){
    let { p2shHex, p2shTx, txidFirstInput, p2shHash } = build
    if (p2shHex && !p2shTx){
        p2shTx = bitcoin.Transaction.fromHex(p2shHex)
        txidFirstInput = p2shTx.getId()
        assertRevealFundingTxMatches(p2shHash, txidFirstInput)
    }
    Object.assign(build, { p2shTx, txidFirstInput })

    if (p2shHash){
        yield* spendP2wshLeg.call(this, build, nextDataBuffer)
    } else {
        fundP2wshLeg.call(this, build, nextDataBuffer)
    }
}

function* spendP2wshLeg(build, nextDataBuffer){
    let { psbt, txidFirstInput, p2shTx, voutPsbtIndex, utxoSequence, p2shHash, estimatedTxSize } = build
    if (!psbt){
        psbt = new bitcoin.Psbt({ network: this.network })
        psbt.addOutput({
            script: bitcoin.payments.embed({
                data: [
                    (yield this.obfuscate(
                        Buffer.concat([
                            Buffer.from(MAGIC_WORD,'utf8'),
                            Buffer.from("p2wsh",'utf8')
                        ]),
                        txidFirstInput
                    ))
                ]
            }).output,
            value: 0
        })
    }

    if (!p2shTx || !p2shTx.outs || voutPsbtIndex >= p2shTx.outs.length) {
        throw new RangeError(`p2shHex transaction does not have output at index ${voutPsbtIndex}`)
    }
    let nextInput = {
        sequence: utxoSequence,
        hash:p2shHash,
        witnessScript:nextDataBuffer,
        index: voutPsbtIndex,
        witnessUtxo:{
            script:p2shTx["outs"][voutPsbtIndex]["script"],
            value:p2shTx["outs"][voutPsbtIndex]["value"]
        }
    }
    psbt.addInput(nextInput)

    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
    voutPsbtIndex = voutPsbtIndex + 1
    Object.assign(build, { psbt, estimatedTxSize, voutPsbtIndex })
}

function fundP2wshLeg(build, nextDataBuffer){
    let { feePerBytes, finalDust, preparedData, revealCustomOutputsValue, revealCustomOutputsFee, psbt, outputSatoshis, estimatedTxSize } = build
    // Size this P2WSH data output to fund its share of the
    // reveal (spending) transaction's fee, mirroring the
    // P2SH branch above. A flat per-output dust value leaves
    // the multi-input reveal tx below the node's min-relay-fee
    // floor (observed on bitcoin-regtest, whose dustThreshold
    // is 546: 1638 sat across 3 dust outputs vs a ~2228 sat
    // floor), so the broadcast is rejected. The estimate uses
    // witness-discounted sizing because P2WSH
    // reveal data lives in the (÷4-weighted) witness.
    let spendingP2wshEstimatedSize = this.estimateSpendingP2wshTx(nextDataBuffer)
    let spendingP2wshEstimatedFee = Math.trunc((spendingP2wshEstimatedSize * feePerBytes) * SATOSHI_UNIT)

    if (spendingP2wshEstimatedFee < finalDust){
        spendingP2wshEstimatedFee = finalDust
    }

    spendingP2wshEstimatedFee = fundRevealFloorPad.call(this, preparedData, spendingP2wshEstimatedFee)

    // Over-fund the first funding output by the reveal-side
    // customOutputs total, plus the miner fee for the bytes
    // they add to the reveal, so the reveal can pay them
    // (consumed once).
    if (revealCustomOutputsValue > 0n || revealCustomOutputsFee > 0){
        spendingP2wshEstimatedFee = asSatValue(BigInt(spendingP2wshEstimatedFee) + revealCustomOutputsValue + BigInt(revealCustomOutputsFee))
        revealCustomOutputsValue = 0n
        revealCustomOutputsFee = 0
    }

    psbt.addOutput({
        address: bitcoin.payments.p2wsh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
        value:spendingP2wshEstimatedFee
    })
    // Account for the data output's value so change is not
    // over-credited. Without this, changeSatoshis below is
    // computed as input - 0 - fee, so the data outputs are
    // funded "for free" and total outputs exceed total
    // inputs; bitcoinjs rejects tx1 with "Outputs are
    // spending more than Inputs". Mirrors the P2SH and
    // MULTISIGN branches, which already track their outputs.
    outputSatoshis = outputSatoshis + BigInt(spendingP2wshEstimatedFee)

    estimatedTxSize = estimatedTxSize
        + TxSizeEstimator.estimateP2wshOutput()
    Object.assign(build, { revealCustomOutputsValue, revealCustomOutputsFee, outputSatoshis, estimatedTxSize })
}

function fundRevealFloorPad(preparedData, spendingP2wshEstimatedFee){
    // Chains such as Litecoin reject a reveal tx whose
    // stripped (non-witness) serialization is below their
    // relay floor (minStandardTxNonWitnessSize). A reveal
    // spending these data outputs is 10 (header) + 41 per
    // P2WSH input + ~20 (OP_RETURN marker) stripped bytes; a
    // single-chunk reveal is only 71 bytes, under Litecoin's
    // 85-byte floor. The reveal builder clears the floor with
    // one extra small payment output (see the p2shHash branch
    // and addRevealSizeFloorPadding below), so fund that
    // output's value here (one dust); otherwise the reveal
    // has no satoshis left to create it after the fee floor.
    let strippedFloor = this.network.minStandardTxNonWitnessSize
    let chunkCount = preparedData["dataBufferArray"].length
    let predictedRevealStripped = 30 + (41 * chunkCount)
    if (strippedFloor && predictedRevealStripped < strippedFloor){
        // Fund the reveal's stripped-size floor-padding output with
        // this.dustAmount, the SAME constant the reveal side spends
        // (see addRevealSizeFloorPadding below). Using finalDust here
        // could over/under-fund the pad when a caller passes a custom
        // dust, leaving the two halves of the flow inconsistent.
        spendingP2wshEstimatedFee = spendingP2wshEstimatedFee + this.dustAmount
    }
    return spendingP2wshEstimatedFee
}

module.exports = { emitP2shChunk, emitP2wshChunk }
