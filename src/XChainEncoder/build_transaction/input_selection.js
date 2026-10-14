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

const bitcoin = require('bitcoinjs-lib')
const TxSizeEstimator = require('../../build/tx_size_estimator')
const { MAX_UTXO_COUNT, parseSatoshiAmount } = require('../../common/validator')
const { OperationalError, ParamTypeError, ParamRangeError } = require('../../build/errors')
const { SATOSHI_UNIT, RESERVATION_TTL_MS, Encoding } = require('../constants.js')
const { jsonSafeSat } = require('../script_amount_helpers.js')
const { feeForVsize } = require('../fee_policy.js')
const { isUnconfirmedUtxo } = require('./input_candidates.js')
const { nestedP2wpkhRedeem } = require('./nested_segwit.js')
const { clearsStrippedFloor } = require('./stripped_floor.js')

function initSelection(build){
    let { estimatedTxSize, fee, psbt, softDustSurcharge } = build
    estimatedTxSize = estimatedTxSize + 43 // change output (worst case: taproot)
    // The output-count varint is 1 byte up to 252 outputs and 3 bytes past that; the
    // 10-byte header counted in initEmissionState assumed 1. A MULTISIGN payload plus
    // the customOutputs cap can pass 252 outputs.
    if (psbt && psbt.txOutputs.length + 1 > 252) estimatedTxSize = estimatedTxSize + 2

    let estimatedFee = 0
    // The caller's explicit fee as asked, before the dust floor can raise it; errors
    // name both when they differ.
    let requestedFee = null
    if (fee != null && fee !== false) {
        // Re-parse with the same exact-integer arbiter the validator uses
        // (toExactInt-based), not parseInt: parseInt silently truncates a
        // fractional value ("100.5" -> 100) for direct library callers that
        // bypass validateFee. parseSatoshiAmount throws RangeError
        // ("fee must be a non-negative integer") on any non-exact or negative
        // value, preserving the previous error contract.
        requestedFee = parseSatoshiAmount(fee, 'fee')
        // An explicit fee pays for size; the soft-dust relay surcharge rides on top.
        estimatedFee = requestedFee + (softDustSurcharge || 0)
    }

    let selectedInputCount = 0
    // Txids of the SELECTED inputs that are still in the mempool. Their
    // ancestor package is what CPFP sizing below has to pay for. An entry with no
    // confirmations field counts as unconfirmed (isUnconfirmedUtxo), so it is sized as
    // a mempool parent; a confirmed one reports an empty ancestor package and asks for nothing.
    const unconfirmedInputTxids = []
    // Candidates the loop skipped because another build holds them. Reported
    // when nothing could be selected, so the caller learns the inputs exist
    // and are spoken for rather than that the address is empty.
    let reservedCandidates = 0
    // Whether the segwit marker and flag have been counted; see framingBytesForInput.
    const segwitMarkerCounted = false
    Object.assign(build, { estimatedTxSize, estimatedFee, requestedFee, selectedInputCount, unconfirmedInputTxids,
        reservedCandidates, segwitMarkerCounted })
}

// The fee selection has to cover: the fee the build will finally charge, which the
// post-selection floor (floorEstimatedFee) never lets fall under the dust threshold.
// Stopping at the unfloored fee left a fundable spend one input short.
function selectionTargetFee(estimatedFee){
    return Math.max(estimatedFee, this.dustAmount)
}

// Transaction framing an input adds beyond its own estimated size: the segwit marker
// and flag (2 weight units, rounded up to 1 vB) with the first witness input, and two
// more bytes of input-count varint when the 253rd input is added.
function framingBytesForInput(build, utxo, selectedInputCount, nested){
    let bytes = 0
    if (!build.segwitMarkerCounted && (nested || this.isSegwitUTXO(utxo))){
        build.segwitMarkerCounted = true
        bytes = bytes + 1
    }
    if (selectedInputCount === 253) bytes = bytes + 2
    return bytes
}

function* selectFundingInputs(build){
    let { p2shHash } = build
    if (!p2shHash){//The p2sh input is already created before
        yield* selectInputs.call(this, build)
        refuseEmptySelection.call(this, build)
        refuseFirstInputRace.call(this, build)
    }
}

// Walks the ordered candidates, claiming and adding inputs until they cover
// outputs plus fee (or, in exact-input mode, until every named one is spent).
function* selectInputs(build){
    let { utxos, preparedData, exactInputs, firstReservedOutpoint, callReservations, psbt, utxoSequence,
        attachPrevTx, fee, feePerBytes, outputSatoshis, estimatedTxSize, estimatedFee, inputSatoshis,
        selectedInputCount, unconfirmedInputTxids, reservedCandidates, softDustSurcharge } = build
    const now = Date.now()
    this.evictExpiredReservations(now)
    let nextUtxoIndex = 0
    while (nextUtxoIndex < utxos.length){
        refuseCappedSelection.call(this, build, nextUtxoIndex, inputSatoshis, estimatedFee, selectedInputCount, now)
        let nextUtxo = utxos[nextUtxoIndex]

        refuseUnsignableInput.call(this, preparedData, nextUtxo)

        if (skipReservedInput.call(this, callReservations, nextUtxo, exactInputs, firstReservedOutpoint, now)){
            reservedCandidates = reservedCandidates + 1
            nextUtxoIndex = nextUtxoIndex + 1
            continue
        }

        nextUtxo.value = parseSatoshiAmount(nextUtxo.value, `utxos[${nextUtxoIndex}].value`, { allowBig: true })

        const nestedRedeem = nestedP2wpkhRedeem.call(this, build, nextUtxo)
        const added = yield* addSelectedInput.call(this, psbt, nextUtxo, utxoSequence, attachPrevTx, estimatedTxSize, inputSatoshis, build.fetchedFromTracker, nestedRedeem)
        estimatedTxSize = added.estimatedTxSize
        inputSatoshis = added.inputSatoshis

        selectedInputCount = selectedInputCount + 1
        estimatedTxSize = estimatedTxSize + framingBytesForInput.call(this, build, nextUtxo, selectedInputCount, !!nestedRedeem)

        if (isUnconfirmedUtxo(nextUtxo)){
            unconfirmedInputTxids.push(nextUtxo.txid)
        }

        // A rate-priced fee also carries the soft-dust relay surcharge (0 off Dogecoin).
        if (fee == null || fee === false) {
            estimatedFee = feeForVsize(estimatedTxSize, feePerBytes, SATOSHI_UNIT) + (softDustSurcharge || 0)
        }

        // Exact-input mode never stops early: the caller named this set
        // because the transaction has to descend from all of it (a CPFP
        // rescue) or spend a specific output (a deliberate chain). Stopping
        // at sufficiency is exactly the behaviour that made a stuck batch
        // unrescuable through this API. Any surplus goes to change, which
        // the shortfall/change math below already handles.
        const targetFee = selectionTargetFee.call(this, estimatedFee)
        if (!exactInputs && inputSatoshis > outputSatoshis + BigInt(targetFee) && clearsStrippedFloor.call(this, build, inputSatoshis, targetFee)){
            break
        }

        nextUtxoIndex = nextUtxoIndex + 1
    }
    Object.assign(build, { estimatedTxSize, estimatedFee, inputSatoshis, selectedInputCount, reservedCandidates })
}

function refuseCappedSelection(build, nextUtxoIndex, inputSatoshis, estimatedFee, selectedInputCount, now){
    if (selectedInputCount < MAX_UTXO_COUNT) return
    if (remainingCandidatesCanFund.call(this, build, nextUtxoIndex, inputSatoshis, estimatedFee, now)){
        throw new ParamRangeError(
            `selected input count would exceed the maximum (${MAX_UTXO_COUNT}) inputs for a single transaction`
        )
    }
    throw new OperationalError(
        'NO_CONFIRMED_UTXO',
        `no input selection can fund the transaction within the ${MAX_UTXO_COUNT}-input maximum without ` +
        'waiting for a larger output to confirm or consolidating the confirmed outputs',
        { selectedInputCount, maximum: MAX_UTXO_COUNT }
    )
}

function remainingCandidatesCanFund(build, nextUtxoIndex, inputSatoshis, estimatedFee, now){
    const { utxos, exactInputs, firstReservedOutpoint, outputSatoshis } = build
    const required = outputSatoshis + BigInt(selectionTargetFee.call(this, estimatedFee))
    let available = inputSatoshis
    for (let index = nextUtxoIndex; index < utxos.length; index++){
        const candidate = utxos[index]
        const outpointKey = candidate.txid + ':' + candidate.vout
        if (!exactInputs && outpointKey !== firstReservedOutpoint && this.isOutpointReserved(outpointKey, now)){
            continue
        }
        available += BigInt(parseSatoshiAmount(candidate.value, `utxos[${index}].value`, { allowBig: true }))
        if (available > required) return true
    }
    return false
}

function refuseUnsignableInput(preparedData, nextUtxo){
    // Envelope commit inputs MUST be segwit. The
    // reveal is pre-built against the UNSIGNED commit's txid, which
    // is only stable when no selected input's signature lands in
    // the txid-covered serialization. Enforced as native-segwit
    // (witness-program scriptPubKey): a P2SH-wrapped segwit UTXO is
    // indistinguishable from plain P2SH here and its scriptSig
    // (redeem-script push) shifts the txid, so it is refused too --
    // stricter than the spec's floor, never looser. Fail closed
    // rather than skip: silently dropping a caller's coin-control
    // input would change what they spend.
    if (preparedData["encoding"] === Encoding.TAPROOT && !this.isSegwitUTXO(nextUtxo)){
        throw new ParamTypeError(
            `TAPROOT commit inputs must be native-segwit UTXOs (witness-program scriptPubKey); ` +
            `utxo ${nextUtxo.txid}:${nextUtxo.vout} is not. A non-segwit input would shift the ` +
            `commit txid at signing time and strand the pre-built reveal.`)
    }

    // Refuse a witness-program input on a chain whose consensus rules have
    // no segwit: there the output is anyone-can-spend and a witnessUtxo
    // input signs nothing the network enforces. Fail closed, never skip.
    if (this.network.supportsSegwit === false && this.isSegwitUTXO(nextUtxo)){
        throw new ParamTypeError(
            `Input ${nextUtxo.txid}:${nextUtxo.vout} carries a witness-program scriptPubKey, ` +
            `which this network does not support (no segwit). Spend legacy inputs on this chain.`)
    }
}

// True when another build holds this candidate; otherwise claims it for this build.
function skipReservedInput(callReservations, nextUtxo, exactInputs, firstReservedOutpoint, now){
    // Double-spend guard: skip any outpoint another create_tx claimed
    // within RESERVATION_TTL_MS, and reserve the ones we take. Two
    // calls for one address would otherwise both pick the largest
    // UTXOs and build conflicting double-spends (or, with identical
    // outputs, the identical transaction). Reserve synchronously here
    // (before the getTransactionHex await below) so a concurrent call
    // observes the claim. Applies to caller-supplied sets too: the SDK
    // and wallet hand over a tracker-fetched set as `utxos`, and the
    // tracker keeps publishing a spent input until it sees the spend,
    // so a chained send re-supplies the input the previous build took.
    // A caller that truly wants to respend a reserved input (an RBF
    // bump) waits out the TTL or restarts the encoder; that is the
    // price of never building the same spend twice.
    // Exact-input mode settled reservations up front: it claimed every
    // named outpoint, or refused the build. Re-checking here would see
    // this call's OWN claims and skip the whole set.
    if (!exactInputs){
        const outpointKey = nextUtxo.txid + ':' + nextUtxo.vout
        // Skip outpoints reserved by OTHER calls, but NOT the one this
        // call pre-reserved for ins[0] above (the obfuscation key binds to it).
        if (outpointKey !== firstReservedOutpoint && this.isOutpointReserved(outpointKey, now)){
            return true
        }
        if (outpointKey !== firstReservedOutpoint){
            this.claimOutpoint(callReservations, outpointKey, now)
        }
    }
    return false
}

// Refuses a UTXO whose stated value differs from its output in the fetched previous tx.
// A legacy sighash does not commit to input amounts, so an understated value would sign
// and the hidden difference would go to miners, past fee guards that read the same figure.
function assertPrevOutValueMatches(prevTxHex, utxo, fetchedFromTracker){
    const outpoint = `${utxo.txid}:${utxo.vout}`
    let prevOut = null
    try {
        prevOut = bitcoin.Transaction.fromHex(prevTxHex).outs[utxo.vout]
    } catch (err) {
        prevOut = null
    }
    let problem = null
    if (!prevOut){
        problem = `previous transaction for utxo ${outpoint} has no output at index ${utxo.vout}`
    } else if (BigInt(prevOut.value) !== BigInt(utxo.value)){
        problem = `utxo ${outpoint} states value ${BigInt(utxo.value).toString()} but the previous transaction ` +
            `pays ${BigInt(prevOut.value).toString()} to that output`
    }
    if (problem === null) return
    // Name who supplied the bad figure: a tracker row is not a caller parameter.
    if (fetchedFromTracker) throw new OperationalError('UTXO_TRACKER_ERROR', `utxo-tracker returned a wrong utxo: ${problem}`)
    throw new ParamRangeError(problem)
}

// nestedRedeem is the P2WPKH redeem script of a P2SH-P2WPKH input, signed as segwit.
function* addSelectedInput(psbt, nextUtxo, utxoSequence, attachPrevTx, estimatedTxSize, inputSatoshis, fetchedFromTracker, nestedRedeem){
    if (nestedRedeem || this.isSegwitUTXO(nextUtxo)){
        let nextInput = {
            hash: nextUtxo.txid,
            index: nextUtxo.vout,
            sequence: utxoSequence,
            witnessUtxo: {
                script: Buffer.from(nextUtxo.scriptPubKey, 'hex'),
                value: nextUtxo.value,
            }
        }
        if (nestedRedeem) nextInput.redeemScript = nestedRedeem
        // A hardware signer needs the FULL previous
        // transaction even for a segwit input, because Ledger takes
        // the outpoint it signs from those bytes rather than from
        // the PSBT's own txid. witnessUtxo alone left the device
        // unable to sign (and, before it failed closed, signing a
        // synthesized outpoint that does not exist). Opt-in: it is
        // one node round trip and one prev tx of PSBT weight per
        // input, which only that caller should pay. Attached NOW,
        // at build time, so the PSBT the user previews is the one
        // that gets signed - hydrating it later would break the
        // byte-identity guarantee the confirm surface rests on.
        if (attachPrevTx) {
            const prevTxHex = yield this.connector.getTransactionHex(nextUtxo.txid)
            // Check the amount too: a hardware signer reads it from these bytes.
            assertPrevOutValueMatches(prevTxHex, nextUtxo, fetchedFromTracker)
            nextInput.nonWitnessUtxo = Buffer.from(prevTxHex, 'hex')
        }
        psbt.addInput(nextInput)
        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
        inputSatoshis = inputSatoshis + BigInt(nextUtxo.value)
    } else {
        let wholeUtxoHex = yield this.connector.getTransactionHex(nextUtxo.txid)
        // Check the stated amount against the node's copy before it enters the fee math.
        assertPrevOutValueMatches(wholeUtxoHex, nextUtxo, fetchedFromTracker)
        let nextInput = {
            hash: nextUtxo.txid,
            index: nextUtxo.vout,
            sequence: utxoSequence,
            nonWitnessUtxo: Buffer.from(wholeUtxoHex, 'hex')
        }
        psbt.addInput(nextInput)
        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
        inputSatoshis = inputSatoshis + BigInt(nextUtxo.value)
    }
    return { estimatedTxSize, inputSatoshis }
}

function refuseEmptySelection(build){
    let { selectedInputCount, reservedCandidates, outputSatoshis } = build
    // Report the fee the build would charge, floor included.
    const estimatedFee = selectionTargetFee.call(this, build.estimatedFee)
    // The caller-facing MAX_UTXO_COUNT cap is intentionally NOT
    // applied to the fetched set before selection (a rich address must
    // stay spendable). Bound the SELECTED input count instead: a tx that
    // genuinely needs more inputs than this is over standardness size and
    // would be rejected at broadcast, so fail here with a precise reason.
    if (selectedInputCount > MAX_UTXO_COUNT){
        throw new ParamRangeError(`selected input count (${selectedInputCount}) exceeds the maximum (${MAX_UTXO_COUNT}) inputs for a single transaction`)
    }

    // No spendable input was selected on the funding/single-tx path: the
    // set was empty of usable outputs or every candidate is reserved by a
    // concurrent selection. Report insufficient funds here, before
    // the fee-rate cap math below, which would otherwise reject a fixed
    // fee against a zero-input transaction's tiny size and mask the real
    // cause. (The reveal path has p2shHash set and never reaches here.)
    if (selectedInputCount === 0){
        // Name the real cause when the inputs exist but are spoken for: a
        // chained send that re-supplied an input the previous build took
        // is not an empty address, and the caller's fix is to wait for
        // that spend to reach the tracker, not to fund the address.
        const allReserved = reservedCandidates > 0
        throw new OperationalError(
            'INSUFFICIENT_FUNDS',
            allReserved
                ? `insufficient funds: all ${reservedCandidates} candidate input(s) are reserved by a transaction ` +
                  `built in the last ${Math.round(RESERVATION_TTL_MS / 60000)} minutes; broadcast that transaction ` +
                  'and wait for its change to appear, or wait for the reservation to lapse'
                : 'insufficient funds: no spendable inputs available (all candidates reserved or empty)',
            { required: jsonSafeSat(outputSatoshis + BigInt(estimatedFee)), available: 0, outputs: jsonSafeSat(outputSatoshis), fee: estimatedFee, reservedCandidates }
        )
    }
}

function refuseFirstInputRace(build){
    let { hasActionPayload, preparedData, txidFirstInput, psbt } = build
    // Fail-closed ins[0] invariant. OP_RETURN and MULTISIGN
    // obfuscate their payload with txidFirstInput, and the decoder derives its
    // deobfuscation key from the first input's txid, so the action only decodes if
    // that outpoint actually landed at ins[0]. The head-of-order splice above makes
    // that true by construction whenever an outpoint could be pre-reserved; it
    // cannot when EVERY fetched outpoint was already reserved and one of them then
    // freed before selection. Fail here so the caller retries, instead of returning
    // a valid transaction whose action silently decodes to nothing (inputs spent,
    // fee burned). P2SH/P2WSH are excluded: on the funding tx they do not use
    // txidFirstInput at all, and on the reveal tx (p2shHash set) this block does not
    // run and the key is re-bound to the phase-1 txid.
    // A payment-only transaction has no action, hence no
    // obfuscation key bound to the first input. The guard below exists to
    // stop an action from silently decoding to nothing; with nothing to
    // decode it would only fail a perfectly good payment whose input
    // selection shifted under a concurrent reservation.
    const keyBindsToFirstInput =
        hasActionPayload && (
            preparedData["encoding"] === Encoding.OP_RETURN ||
            preparedData["encoding"] === Encoding.MULTISIGN
        )
    if (keyBindsToFirstInput && txidFirstInput != null){
        // psbt.txInputs[0].hash is the internal little-endian outpoint hash; copy
        // before reversing so the PSBT's own buffer is not mutated.
        const actualFirstTxid = Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex')
        if (actualFirstTxid !== txidFirstInput){
            throw new OperationalError(
                'INPUT_SELECTION_RACE',
                'input selection raced a concurrent reservation: the obfuscation key is bound to an outpoint that is not the first input; retry the request',
                { expectedFirstInput: txidFirstInput, actualFirstInput: actualFirstTxid }
            )
        }
    }
}

module.exports = { initSelection, selectFundingInputs }
