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
const util = require('node:util');
const TxSizeEstimator = require('../../build/tx_size_estimator')
const { logger, TAPROOT_LEAF_VERSION, SATOSHI_UNIT, Encoding } = require('../constants.js')
const { envelopeTapLeafHash, asSatValue } = require('../script_amount_helpers.js')
const { packageFeeUpliftSatoshis, maxCpfpUpliftSat } = require('../fee_policy.js')
const { resolveCallerAddress } = require('../request_resolution.js')

// The change output, then the P2WSH reveal's stripped-size floor pad.
function emitChangeAndPad(build){
    let { changeSatoshis, change, psbt, p2shHash, preparedData, pubkey } = build
    if ((changeSatoshis > 0) && (change)) {
        // Emit change only at or above the relay floor for authored outputs; below it the
        // output is non-standard or soft dust that makes the transaction unrelayable, so it
        // folds into the miner fee instead.
        if (changeSatoshis >= this.outputFloor) {
            psbt.addOutput({
                address: change,
                value: asSatValue(changeSatoshis)
            })
        }
    }

    // A P2WSH reveal that spends a single data chunk is just 1 input + 1
    // OP_RETURN output: 71 stripped (non-witness) bytes, which is BELOW the
    // relay floor on every chain we support. The floor is a POLICY constant
    // (Bitcoin Core's MIN_STANDARD_TX_NONWITNESS_SIZE = 82, Litecoin ~85),
    // NOT the 65-byte CONSENSUS minimum that guards the 64-byte-transaction
    // CVE. coins/BTC.js carried that consensus 65 until 2026-07-31, so this
    // pad never fired on Bitcoin and a single-chunk P2WSH reveal was
    // unbroadcastable there (measured live: 71 stripped bytes rejected
    // "tx-size-small", 82 accepted). Corrected to 82 with the consensus pin
    // regenerated across every repo vendoring BTC.js.
    //
    // The payload lives in the witness and does not count toward stripped
    // size, so this shape stays small however large the file is. Lift the
    // reveal over the chain's floor with one
    // small payment output back to the caller's own address. A second
    // OP_RETURN would be non-standard (multi-op-return), so we cannot pad
    // with that. The funding tx already over-funded this reveal by one dust
    // (see the P2WSH funding branch) so the output's value is available.
    let strippedFloor = this.network.minStandardTxNonWitnessSize
    if (p2shHash && preparedData["encoding"] === Encoding.P2WSH && strippedFloor){
        let padAddress = change || resolveCallerAddress(pubkey, this.network)
        if (padAddress && this.strippedTxSize(psbt) < strippedFloor){
            psbt.addOutput({
                address: padAddress,
                value: this.dustAmount
            })
        }
    }
}

function* sweepP2shReveal(build){
    let { p2shHash, preparedData, phaseLegInputSatoshis, customOutputs, feePerBytes, estimatedFee, outputSatoshis,
        change, pubkey, psbt } = build
    // Sweep the P2SH reveal's leg surplus back to the
    // caller. The funding tx (P2SH funding branch above) tops the first leg
    // up by the reveal's own fee plus one dust precisely so this output can
    // exist: without it the reveal's only output is the zero-value OP_RETURN
    // marker, every satoshi of the legs goes to miners, and the SDK's
    // FULL_BURN_FEE guard (correctly) refuses to sign, stranding the
    // confirmed commit. The fee the reveal keeps is the larger of the
    // dust-/explicit-fee-floored estimatedFee above and the same
    // whole-reveal size estimate the funding side used (estimateP2shRevealTx,
    // at this call's fee rate, including the emitted customOutputs' bytes);
    // everything above it returns to `change` or the caller's own address.
    // Legs funded before this fix carry no headroom, leave no surplus at or
    // above dust, and produce a byte-identical (still outputless) reveal.
    if (p2shHash && preparedData["encoding"] === Encoding.P2SH && phaseLegInputSatoshis > 0n){
        let revealEmittedOutputBytes = 43 // change output (worst case), matching the reserve above
        if (customOutputs && Array.isArray(customOutputs)){
            for (let i = 0; i < customOutputs.length; i++){
                revealEmittedOutputBytes = revealEmittedOutputBytes + TxSizeEstimator.estimateOutputSizeForAddress(customOutputs[i].address, this.network)
            }
        }
        const revealSizeForFee = this.estimateP2shRevealTx(preparedData["dataBufferArray"], revealEmittedOutputBytes)
        let revealFeeKept = Math.trunc((revealSizeForFee * feePerBytes) * SATOSHI_UNIT)
        if (revealFeeKept < estimatedFee){
            revealFeeKept = estimatedFee
        }

        revealFeeKept = (yield* upliftRevealForCommit.call(this, build, revealSizeForFee, revealFeeKept))

        let revealSurplus = phaseLegInputSatoshis - outputSatoshis - BigInt(revealFeeKept)
        let sweepAddress = change || resolveCallerAddress(pubkey, this.network)
        // The sweep is an authored output: below the relay floor the surplus stays as fee.
        if (sweepAddress && revealSurplus >= BigInt(this.outputFloor)){
            psbt.addOutput({
                address: sweepAddress,
                value: asSatValue(revealSurplus)
            })
        }
    }
}

function* upliftRevealForCommit(build, revealSizeForFee, revealFeeKept){
    let { feePerBytes, p2shHash } = build
    // Keep the package prefund as FEE instead of sweeping it home.
    //
    // The reveal spends only the commit's legs, so commit and reveal are
    // one mempool package and the miner weighs them together. The funding
    // side sized these legs at the package rate precisely so this
    // transaction can pay the commit's shortfall; without this the extra
    // lands in the surplus and goes straight back to the caller's change,
    // leaving the package exactly as under-target as it was.
    //
    // The commit's fee is read from the node's mempool rather than
    // re-derived: the commit is a broadcast transaction by now, its ACTUAL
    // size and fee are what the miner sees, and this also picks up any
    // unconfirmed ancestors it inherited. An already-confirmed commit
    // reports an empty package and asks for nothing, which is correct - a
    // confirmed parent is no longer part of anyone's package. Any failure
    // (no method, unreachable node, RPC error) leaves the fee exactly as
    // it was; the reveal is then priced per-transaction, as before.
    const revealUpliftBound = maxCpfpUpliftSat()
    if (revealUpliftBound > 0 && feePerBytes > 0 &&
        this.connector && typeof this.connector.getUnconfirmedAncestorPackage === 'function'){
        let commitPackage = null
        try {
            commitPackage = (yield this.connector.getUnconfirmedAncestorPackage([p2shHash]))
        } catch (err) {
            logger.warn(util.format('Reveal package fee sizing skipped: commit lookup failed:', err.message))
        }
        const wanted = commitPackage ? packageFeeUpliftSatoshis({
            currentFee: revealFeeKept,
            txSize: revealSizeForFee,
            ancestorSize: commitPackage.size,
            ancestorFees: commitPackage.fees,
            targetFeePerBytes: feePerBytes,
            satoshiUnit: SATOSHI_UNIT
        }) : 0
        if (wanted > 0){
            revealFeeKept = clampRevealUplift.call(this, build, commitPackage, wanted, revealUpliftBound, revealSizeForFee, revealFeeKept)
        }
    }
    return revealFeeKept
}

// The reveal-side uplift actually kept as fee, bounded by the legs' spendable surplus.
function clampRevealUplift(build, commitPackage, wanted, revealUpliftBound, revealSizeForFee, revealFeeKept){
    let { customOutputs, phaseLegInputSatoshis, outputSatoshis, feePerBytes } = build
// The legs are the only money this transaction has, and every
// satoshi above the fee is already spoken for by the outputs
// it must emit. Spend the surplus and not one unit more.
//
// A reveal with no customOutputs leaves exactly one value
// output, the swept change, and that output is what keeps it
// off the SDK's FULL_BURN_FEE refusal. Reserve its floor here:
// eating it would strand the confirmed commit outright, which
// is a far worse outcome than a package that confirms late.
const emitsValueOutput = !!(customOutputs && Array.isArray(customOutputs) && customOutputs.length > 0)
const sweepReserve = emitsValueOutput ? 0n : BigInt(this.outputFloor)
const spendable = phaseLegInputSatoshis - outputSatoshis - BigInt(revealFeeKept) - sweepReserve
let allowed = Math.min(wanted, revealUpliftBound)
if (spendable <= 0n) allowed = 0
else if (spendable < BigInt(allowed)) allowed = Number(spendable)
if (allowed < wanted){
    const packageSize = commitPackage.size + revealSizeForFee
    const packageFee = Math.round(commitPackage.fees * SATOSHI_UNIT) + revealFeeKept + allowed
    logger.warn(`Reveal package fee uplift clamped to ${allowed} of ${wanted} base units: the commit ` +
        `package totals ${commitPackage.size} bytes, so the commit/reveal package will pay ` +
        `${Math.round(packageFee / packageSize * 1000)} base units/kB against a target of ` +
        `${Math.round(feePerBytes * SATOSHI_UNIT * 1000)} and may stay unmined. The reveal has no ` +
        `other input to raise, so rebuild the commit with a package-aware fee.`)
}
if (allowed > 0){
    revealFeeKept = revealFeeKept + allowed
}
    return revealFeeKept
}

function buildEnvelopeReveal(build){
    let { envelopeContext } = build
    // Envelope reveal construction. Runs only on the
    // TAPROOT funding path, after input selection and change, so the commit
    // transaction is final in shape and its unsigned txid is the txid the
    // network will see (segwit-only inputs, enforced above).
    let revealPsbt = null
    let envelopeResult = null
    Object.assign(build, { revealPsbt, envelopeResult })
    if (envelopeContext){
        locateEnvelopeCommit.call(this, build)
        buildRevealPsbt.call(this, build)
    }
}

// The commit's unsigned txid, the envelope output's index, and the control block.
function locateEnvelopeCommit(build){
    let { psbt, envelopeContext } = build
    // Every commit input is signed SIGHASH_ALL. Attribution rides
    // the commit's ins[0]; ANYONECANPAY-style signing would make index 0
    // third-party-insertable in a replacement. The PSBT field makes the
    // requirement explicit to whatever signs it.
    for (let i = 0; i < psbt.inputCount; i++){
        psbt.updateInput(i, { sighashType: bitcoin.Transaction.SIGHASH_ALL })
    }

    const commitTx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
    const commitTxid = commitTx.getId()
    // The envelope commit output is emitted first, so this is vout 0 by
    // construction; located by script rather than assumed, so a future
    // emission-order change cannot silently strand the reveal.
    const commitVout = commitTx.outs.findIndex(o => o.script.equals(envelopeContext.commitPayment.output))

    // Control block for the script-path spend: single-leaf tree, no
    // merkle path, 33 bytes (leaf version + parity bit, then the
    // internal key). Derived from the SAME payment object that built
    // the commit output, so it cannot drift from what was committed.
    const revealPayment = bitcoin.payments.p2tr({
        internalPubkey: envelopeContext.internalPubkey,
        scriptTree: { output: envelopeContext.envelopeScript },
        redeem: { output: envelopeContext.envelopeScript, redeemVersion: TAPROOT_LEAF_VERSION },
        network: this.network
    })
    const controlBlock = revealPayment.witness[revealPayment.witness.length - 1]
    Object.assign(build, { commitTxid, commitVout, controlBlock })
}

function buildRevealPsbt(build){
    let { envelopeContext, utxoSequence, commitTxid, commitVout, controlBlock, revealPsbt, envelopeResult } = build
    revealPsbt = new bitcoin.Psbt({ network: this.network })
    // Reveal input 0 MUST be the commit outpoint; the decoder's
    // recognition and attribution assume it. RBF preference mirrors the
    // commit (the sequence toggle is the shipped replacement mechanism).
    revealPsbt.addInput({
        hash: commitTxid,
        index: commitVout,
        sequence: utxoSequence,
        witnessUtxo: {
            script: envelopeContext.commitPayment.output,
            value: envelopeContext.commitValue
        },
        tapInternalKey: envelopeContext.internalPubkey,
        tapLeafScript: [{
            leafVersion: TAPROOT_LEAF_VERSION,
            script: envelopeContext.envelopeScript,
            controlBlock
        }]
    })
    // Change back to the caller: the commit value minus the reveal's
    // prefunded fee (and minus the floor pad's dust when present) is
    // exactly the dust floor by construction; it exists because the
    // reveal must carry an output and it doubles as the CPFP handle.
    const revealChangeValue = envelopeContext.commitValue
        - envelopeContext.revealFee
        - (envelopeContext.revealPadNeeded ? this.dustAmount : 0)
    revealPsbt.addOutput({
        address: envelopeContext.revealChangeAddress,
        value: revealChangeValue
    })
    if (envelopeContext.revealPadNeeded){
        revealPsbt.addOutput({
            address: envelopeContext.revealChangeAddress,
            value: this.dustAmount
        })
    }

    envelopeResult = {
        commitTxid,
        commitVout,
        commitValue: envelopeContext.commitValue,
        commitAddress: envelopeContext.commitPayment.address,
        internalPubkey: envelopeContext.internalPubkey.toString('hex'),
        tapleafHash: envelopeTapLeafHash(envelopeContext.envelopeScript).toString('hex'),
        controlBlock: controlBlock.toString('hex'),
        revealFee: envelopeContext.revealFee
    }
    Object.assign(build, { revealPsbt, envelopeResult })
}

module.exports = { emitChangeAndPad, sweepP2shReveal, buildEnvelopeReveal }
