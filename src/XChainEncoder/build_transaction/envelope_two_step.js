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
 **********************************************************************/

const bitcoin = require('bitcoinjs-lib')
const { OperationalError, ParamTypeError } = require('../../build/errors')
const { TAPROOT_LEAF_VERSION, Encoding, SATOSHI_UNIT, BURN_BACKSTOP_MULTIPLIER, logger } = require('../constants.js')
const { envelopeTapLeafHash } = require('../script_amount_helpers.js')
const { backstopReferenceFeePerBytes, feeForVsize } = require('../fee_policy.js')

function hasUnlockingData(input){
    return input.script.length > 0 || input.witness.length > 0
}

function parseSignedCommit(hex){
    let tx
    try {
        tx = bitcoin.Transaction.fromHex(hex)
    } catch (err) {
        throw new ParamTypeError('options.envelopeCommitHex must be a valid signed transaction hex string')
    }
    if (tx.ins.length === 0 || tx.ins.some(input => !hasUnlockingData(input))){
        throw new ParamTypeError('options.envelopeCommitHex must be fully signed: every commit input needs scriptSig or witness unlocking data')
    }
    return tx
}

function locateCommitOutput(tx, envelopeContext){
    const matches = []
    for (let i = 0; i < tx.outs.length; i++) {
        if (tx.outs[i].script.equals(envelopeContext.commitPayment.output)) matches.push(i)
    }
    if (matches.length !== 1){
        throw new ParamTypeError('options.envelopeCommitHex must contain exactly one output for this envelope leaf')
    }
    return matches[0]
}

function bindSignedCommitValue(build, tx, commitVout){
    const context = build.envelopeContext
    const actualValue = Number(tx.outs[commitVout].value)
    const pad = context.revealPadNeeded ? this.outputFloor : 0
    const fundedFee = actualValue - build.finalDust - pad
    const relayFee = feeForVsize(context.revealVsize, build.relayFeePerKb / 1000, SATOSHI_UNIT)
    const minimumFee = Math.max(this.dustAmount, relayFee)
    if (fundedFee < minimumFee){
        throw new OperationalError('ENVELOPE_COMMIT_UNDERFUNDED', `envelope commit leaves a ${fundedFee} satoshi reveal fee, below the ${minimumFee} satoshi minimum; recover it with create_envelope_cancel_tx`)
    }
    const reference = backstopReferenceFeePerBytes(build)
    if (!(reference > 0)) throw new Error('Reveal fee safety cannot be verified without a node or relay fee reference')
    const ceiling = Math.max(this.dustAmount,
        feeForVsize(tx.virtualSize() + context.revealVsize, reference, SATOSHI_UNIT) * BURN_BACKSTOP_MULTIPLIER)
    context.commitValue = actualValue
    if (fundedFee < context.revealFee){
        logger.warn(`Envelope commit funds ${fundedFee} satoshis for the reveal, under the ${context.revealFee} this call's rate asks for; its change output stays a CPFP handle`)
    }
    if (fundedFee <= ceiling) context.revealFee = fundedFee
    else logger.warn(`Envelope commit funds ${fundedFee} satoshis for the reveal, above the burn ceiling; returning the excess as reveal change`)
}

function controlBlockFor(envelopeContext, network){
    const payment = bitcoin.payments.p2tr({
        internalPubkey: envelopeContext.internalPubkey,
        scriptTree: { output: envelopeContext.envelopeScript },
        redeem: { output: envelopeContext.envelopeScript, redeemVersion: TAPROOT_LEAF_VERSION },
        network
    })
    return payment.witness[payment.witness.length - 1]
}

function prepareTwoStepReveal(build){
    const tx = parseSignedCommit(build.options.envelopeCommitHex)
    const envelopeContext = build.envelopeContext
    const commitVout = locateCommitOutput(tx, envelopeContext)
    bindSignedCommitValue.call(this, build, tx, commitVout)
    const commitTxid = tx.getId()
    const outpoint = `${commitTxid}:${commitVout}`
    const now = Date.now()
    if (this.isOutpointReserved(outpoint, now)){
        throw new OperationalError(
            'ENVELOPE_COMMIT_OUTPOINT_RESERVED',
            `envelope commit output ${outpoint} is reserved by another transaction built inside the ` +
                'reservation window (a reveal already built from this commit, an envelope cancel, or any ' +
                'create_tx that selected it); broadcast that transaction, release its reservation, or wait ' +
                'for the reservation to lapse',
            { outpoint }
        )
    }
    this.claimOutpoint(build.callReservations, outpoint, now)
    build.twoStepSignedCommit = tx
    build.twoStepEnvelopeContext = envelopeContext
    build.twoStepCommitVout = commitVout
    build.envelopeContext = null
    build.revealPrefund = null
    build.p2shHash = commitTxid
}

function envelopeRecord(envelopeContext, commitTxid, commitVout, controlBlock){
    const record = {
        commitVout,
        commitValue: envelopeContext.commitValue,
        commitAddress: envelopeContext.commitPayment.address,
        internalPubkey: envelopeContext.internalPubkey.toString('hex'),
        tapleafHash: envelopeTapLeafHash(envelopeContext.envelopeScript).toString('hex'),
        controlBlock: controlBlock.toString('hex'),
        revealFee: envelopeContext.revealFee
    }
    if (commitTxid) record.commitTxid = commitTxid
    return record
}

function finishTwoStepCommit(build, result){
    const envelopeContext = build.envelopeContext
    const controlBlock = controlBlockFor(envelopeContext, this.network)
    result.carrierScripts = [envelopeContext.envelopeScript.toString('hex')]
    result.envelope = envelopeRecord(envelopeContext, null, 0, controlBlock)
}

function finishTwoStepReveal(build){
    const tx = build.twoStepSignedCommit
    const envelopeContext = build.twoStepEnvelopeContext
    const commitVout = build.twoStepCommitVout
    const commitTxid = tx.getId()
    const controlBlock = controlBlockFor(envelopeContext, this.network)
    const psbt = new bitcoin.Psbt({ network: this.network })
    psbt.addInput({
        hash: commitTxid,
        index: commitVout,
        sequence: build.utxoSequence,
        witnessUtxo: {
            script: envelopeContext.commitPayment.output,
            value: tx.outs[commitVout].value
        },
        tapInternalKey: envelopeContext.internalPubkey,
        tapLeafScript: [{
            leafVersion: TAPROOT_LEAF_VERSION,
            script: envelopeContext.envelopeScript,
            controlBlock
        }]
    })
    const revealChangeValue = envelopeContext.commitValue
        - envelopeContext.revealFee
        - (envelopeContext.revealPadNeeded ? this.outputFloor : 0)
    psbt.addOutput({ address: envelopeContext.revealChangeAddress, value: revealChangeValue })
    if (envelopeContext.revealPadNeeded){
        psbt.addOutput({ address: envelopeContext.revealChangeAddress, value: this.outputFloor })
    }
    build.callReservations.buildTxid = this.refuseDuplicateBuild(psbt, Date.now())
    return {
        psbt,
        encoding: Encoding.TAPROOT,
        carrierScripts: [envelopeContext.envelopeScript.toString('hex')],
        envelope: envelopeRecord(envelopeContext, commitTxid, commitVout, controlBlock)
    }
}

module.exports = { prepareTwoStepReveal, finishTwoStepCommit, finishTwoStepReveal }
