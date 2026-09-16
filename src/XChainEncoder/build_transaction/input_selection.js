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

const TxSizeEstimator = require('../../build/tx_size_estimator')
const { MAX_UTXO_COUNT, parseSatoshiAmount } = require('../../common/validator')
const { OperationalError } = require('../../build/errors')
const { SATOSHI_UNIT, RESERVATION_TTL_MS, Encoding } = require('../constants.js')
const { jsonSafeSat } = require('../script_amount_helpers.js')

function initSelection(build){
    let { estimatedTxSize, fee } = build
    estimatedTxSize = estimatedTxSize + 43 // change output (worst case: taproot)

    let estimatedFee = 0
    if (fee != null && fee !== false) {
        // Re-parse with the same exact-integer arbiter the validator uses
        // (toExactInt-based), not parseInt: parseInt silently truncates a
        // fractional value ("100.5" -> 100) for direct library callers that
        // bypass validateFee. parseSatoshiAmount throws RangeError
        // ("fee must be a non-negative integer") on any non-exact or negative
        // value, preserving the previous error contract.
        estimatedFee = parseSatoshiAmount(fee, 'fee')
    }

    let selectedInputCount = 0
    // Txids of the SELECTED inputs that are still in the mempool. Their
    // ancestor package is what CPFP sizing below has to pay for; an entry
    // with no confirmations field is treated as confirmed, so a UTXO source
    // that omits it degrades to per-transaction sizing rather than to a
    // guess about someone else's fee.
    const unconfirmedInputTxids = []
    // Candidates the loop skipped because another build holds them. Reported
    // when nothing could be selected, so the caller learns the inputs exist
    // and are spoken for rather than that the address is empty.
    let reservedCandidates = 0
    Object.assign(build, { estimatedTxSize, estimatedFee, selectedInputCount, unconfirmedInputTxids, reservedCandidates })
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
        selectedInputCount, unconfirmedInputTxids, reservedCandidates } = build
    const now = Date.now()
    this.evictExpiredReservations(now)
    let nextUtxoIndex = 0
    while (nextUtxoIndex < utxos.length){
        let nextUtxo = utxos[nextUtxoIndex]

        refuseUnsignableInput.call(this, preparedData, nextUtxo)

        if (skipReservedInput.call(this, callReservations, nextUtxo, exactInputs, firstReservedOutpoint, now)){
            reservedCandidates = reservedCandidates + 1
            nextUtxoIndex = nextUtxoIndex + 1
            continue
        }

        nextUtxo.value = parseSatoshiAmount(nextUtxo.value, `utxos[${nextUtxoIndex}].value`, { allowBig: true })

        const added = yield* addSelectedInput.call(this, psbt, nextUtxo, utxoSequence, attachPrevTx, estimatedTxSize, inputSatoshis)
        estimatedTxSize = added.estimatedTxSize
        inputSatoshis = added.inputSatoshis

        selectedInputCount = selectedInputCount + 1

        if (nextUtxo.confirmations == 0){
            unconfirmedInputTxids.push(nextUtxo.txid)
        }

        if (fee == null || fee === false) {
            estimatedFee = Math.trunc(estimatedTxSize * feePerBytes * SATOSHI_UNIT)
        }

        // Exact-input mode never stops early: the caller named this set
        // because the transaction has to descend from all of it (a CPFP
        // rescue) or spend a specific output (a deliberate chain). Stopping
        // at sufficiency is exactly the behaviour that made a stuck batch
        // unrescuable through this API. Any surplus goes to change, which
        // the shortfall/change math below already handles.
        if (!exactInputs && inputSatoshis > outputSatoshis + BigInt(estimatedFee)){
            break
        }

        nextUtxoIndex = nextUtxoIndex + 1
    }
    Object.assign(build, { estimatedTxSize, estimatedFee, inputSatoshis, selectedInputCount, reservedCandidates })
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
        throw new TypeError(
            `TAPROOT commit inputs must be native-segwit UTXOs (witness-program scriptPubKey); ` +
            `utxo ${nextUtxo.txid}:${nextUtxo.vout} is not. A non-segwit input would shift the ` +
            `commit txid at signing time and strand the pre-built reveal.`)
    }

    // Refuse a witness-program input on a chain whose consensus rules have
    // no segwit: there the output is anyone-can-spend and a witnessUtxo
    // input signs nothing the network enforces. Fail closed, never skip.
    if (this.network.supportsSegwit === false && this.isSegwitUTXO(nextUtxo)){
        throw new TypeError(
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

function* addSelectedInput(psbt, nextUtxo, utxoSequence, attachPrevTx, estimatedTxSize, inputSatoshis){
    if (this.isSegwitUTXO(nextUtxo)){
        let nextInput = {
            hash: nextUtxo.txid,
            index: nextUtxo.vout,
            sequence: utxoSequence,
            witnessUtxo: {
                script: Buffer.from(nextUtxo.scriptPubKey, 'hex'),
                value: nextUtxo.value,
            }
        }
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
            nextInput.nonWitnessUtxo = Buffer.from(prevTxHex, 'hex')
        }
        psbt.addInput(nextInput)
        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
        inputSatoshis = inputSatoshis + BigInt(nextUtxo.value)
    } else {
        let wholeUtxoHex = yield this.connector.getTransactionHex(nextUtxo.txid)
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
    let { selectedInputCount, reservedCandidates, outputSatoshis, estimatedFee } = build
    // The caller-facing MAX_UTXO_COUNT cap is intentionally NOT
    // applied to the fetched set before selection (a rich address must
    // stay spendable). Bound the SELECTED input count instead: a tx that
    // genuinely needs more inputs than this is over standardness size and
    // would be rejected at broadcast, so fail here with a precise reason.
    if (selectedInputCount > MAX_UTXO_COUNT){
        throw new RangeError(`selected input count (${selectedInputCount}) exceeds the maximum (${MAX_UTXO_COUNT}) inputs for a single transaction`)
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
