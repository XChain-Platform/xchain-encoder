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
const { parseSatoshiAmount } = require('../../common/validator')
const { SATOSHI_UNIT, Encoding } = require('../constants.js')
const { resolveCallerAddress } = require('../request_resolution.js')
const { emitP2shChunk, emitP2wshChunk } = require('./script_hash_legs.js')

function prepareDataChunks(build){
    let { p2shHash, psbt, hasActionPayload, finalDataBuffer, encoding, pubkey, compressedPubKey } = build
    if (!p2shHash){//We need to prepare the data to know which inputs the p2sh will have
        psbt = new bitcoin.Psbt({ network: this.network })
    }

    // With no action payload there is nothing to encode, chunk or obfuscate,
    // so skip prepareData entirely and hand the emission loop an empty chunk
    // list: it then writes no nulldata output and the transaction is just its
    // customOutputs plus change. The encoding is reported as OP_RETURN because
    // every downstream single-transaction branch keys off that value (the
    // P2SH/P2WSH two-phase paths must not engage for a payment), and a caller
    // that explicitly asked for a chunked encoding while supplying no payload
    // has nothing to chunk regardless.
    let preparedData = hasActionPayload
        ? this.prepareData(finalDataBuffer, encoding, pubkey, compressedPubKey)
        : { encoding: Encoding.OP_RETURN, dataBufferArray: [] }
    Object.assign(build, { psbt, preparedData })
}

function priceRevealCustomOutputs(build){
    let { preparedData, p2shHash, customOutputs, feePerBytes } = build
    // P2SH/P2WSH is a two-tx flow: this funding tx (p2shHash null) creates the
    // P2SH/P2WSH outputs, and a later reveal tx (p2shHash set) spends them and
    // is the tx the indexer treats as the action. customOutputs (e.g. the
    // native-fee protocol-fee output) must therefore be EMITTED on the reveal,
    // not here on the funding tx. But the reveal's only inputs are these funding
    // outputs, so the funding outputs must carry enough value for the reveal to
    // pay both its miner fee and those reveal-side customOutputs. We fold the
    // customOutputs total into the FIRST funding output here, and skip emitting
    // customOutputs on this funding tx below (see the customOutputs block). On
    // the reveal (p2shHash set) customOutputs ARE emitted, funded by this value,
    // so they are paid exactly once. Single-tx encodings (OP_RETURN/MULTISIGN)
    // are unaffected: they emit customOutputs directly on their only tx.
    //
    // Value alone is not enough. Each reveal-side customOutput also
    // makes the reveal BIGGER, and the reveal's whole miner fee comes from
    // these funding outputs. estimateSpendingP2shTx/estimateSpendingP2wshTx
    // size the reveal as "one data input + the OP_RETURN marker" only, so a
    // single-chunk reveal carrying e.g. a 34-byte native-fee output came up
    // ~25 bytes short of the 1 sat/vB floor and the node rejected it with
    // min-relay-fee-not-met. Multi-chunk reveals only survived by accident:
    // the per-chunk estimate repeats the tx header and marker output, and
    // that slack absorbed the missing bytes. So charge the bytes here too.
    const isP2shFamily = preparedData["encoding"] === Encoding.P2SH || preparedData["encoding"] === Encoding.P2WSH
    let revealCustomOutputsValue = 0n
    let revealCustomOutputsBytes = 0
    if (!p2shHash && isP2shFamily && customOutputs && Array.isArray(customOutputs)){
        for (let i = 0; i < customOutputs.length; i++){
            revealCustomOutputsValue += BigInt(parseSatoshiAmount(customOutputs[i].value, `customOutputs[${i}].value`, { allowBig: true }))
            revealCustomOutputsBytes += TxSizeEstimator.estimateOutputSizeForAddress(customOutputs[i].address, this.network)
        }
    }
    // Round UP: a truncated fraction of a satoshi is exactly the kind of
    // off-by-one that lands the reveal a hair under the relay floor.
    let revealCustomOutputsFee = (revealCustomOutputsBytes > 0 && feePerBytes > 0)
        ? Math.ceil(revealCustomOutputsBytes * feePerBytes * SATOSHI_UNIT)
        : 0
    Object.assign(build, { isP2shFamily, revealCustomOutputsValue, revealCustomOutputsBytes, revealCustomOutputsFee })
}

function initEmissionState(build){
    let outputSatoshis = 0n
    let voutPsbtIndex = 0
    let obfuscatedData

    // Reveal-headroom state for the P2SH two-phase flow.
    // p2shRevealHeadroomFunded marks the one-time first-leg top-up on the
    // FUNDING tx (the reveal's whole fee plus one dust for the change output
    // the reveal must leave); phaseLegInputSatoshis accumulates the funding
    // leg values the REVEAL spends, so the surplus sweep after the emission
    // loop can price the change output it returns to the caller.
    let p2shRevealHeadroomFunded = false
    let phaseLegInputSatoshis = 0n

    // Reconstructed phase-1 funding tx on the reveal path, shared by the P2SH
    // and P2WSH branches below (both spend its outputs by index). Hoisted to the
    // loop's enclosing scope so the input-index bounds guard can reuse it, and
    // parsed once (memoized via `!p2shTx`) rather than re-decoded per data chunk;
    // the parse is loop-invariant (p2shHex and txidFirstInput never change here).
    let p2shTx = null

    // Envelope (TAPROOT) build context, populated by the emission loop and
    // consumed after input selection to construct the reveal PSBT against
    // the unsigned commit's txid (stable: commit inputs are segwit-only).
    let envelopeContext = null

    // Two-phase reveal prefund bookkeeping, set by whichever commit branch
    // sized a whole-reveal fee into a commit output (P2SH first leg, TAPROOT
    // commit output). Consumed by the package-prefund pass after the commit's
    // own fee is final. See that pass for why it cannot be done in the branch.
    //   outputIndex - the commit output carrying the reveal's fee money
    //   revealSize  - whole-reveal size estimate, the package's child bytes
    //   revealFee   - the fee that output currently prefunds
    let revealPrefund = null

    let estimatedTxSize = 0
    Object.assign(build, { outputSatoshis, voutPsbtIndex, obfuscatedData, p2shRevealHeadroomFunded, phaseLegInputSatoshis,
        p2shTx, envelopeContext, revealPrefund, estimatedTxSize })
}

// One carrier output (or reveal input) per prepared chunk, by encoding.
function* emitDataOutputs(build){
    let { preparedData } = build
    for (let nextDataBufferIndex in preparedData["dataBufferArray"]){
        let nextDataBuffer = preparedData["dataBufferArray"][nextDataBufferIndex]

        switch (preparedData["encoding"]){
            case Encoding.OP_RETURN:
                yield* emitOpReturnChunk.call(this, build, nextDataBuffer)
                break
            case Encoding.P2SH:
                yield* emitP2shChunk.call(this, build, nextDataBuffer)
                break
            case Encoding.P2WSH:
                yield* emitP2wshChunk.call(this, build, nextDataBuffer)
                break
            case Encoding.MULTISIGN:
                yield* emitMultisignChunk.call(this, build, nextDataBuffer)
                break
            case Encoding.TAPROOT: {
                    emitEnvelopeCommit.call(this, build, nextDataBuffer)
                break
            }
        }
    }
}

function* emitOpReturnChunk(build, nextDataBuffer){
    let { obfuscatedData, txidFirstInput, psbt, estimatedTxSize } = build
    obfuscatedData = (yield this.obfuscate(nextDataBuffer, txidFirstInput))
    let opReturnScript = bitcoin.payments.embed({ data: [obfuscatedData] })

    psbt.addOutput({
        script: opReturnScript.output,
        value: 0
    })

    // Oversize is handled upstream: prepareData rejects an OP_RETURN
    // payload larger than chunksSize (single-OP_RETURN policy throw),
    // so every obfuscatedData reaching here fits one standard nulldata
    // output and this per-chunk size estimate is exact.
    estimatedTxSize = estimatedTxSize
        + TxSizeEstimator.estimateOpReturnOutput(obfuscatedData)
    Object.assign(build, { obfuscatedData, estimatedTxSize })
}

function* emitMultisignChunk(build, nextDataBuffer){
    let { obfuscatedData, txidFirstInput, compressedPubKey, finalDust, psbt, outputSatoshis, estimatedTxSize } = build
    obfuscatedData = (yield this.obfuscate(nextDataBuffer, txidFirstInput))
    let pubkey1 = yield this.dataToPubkey(obfuscatedData.slice(0, 32))
    let pubkey2 = yield this.dataToPubkey(obfuscatedData.slice(32, obfuscatedData.length))
    let pubkey3 = Buffer.from(compressedPubKey,"hex")

    let pubkeys = [
        pubkey1,
        pubkey2,
        pubkey3
    ]

    let multisignScript = bitcoin.payments.p2ms(
        {
            m:1, //We only need one signature
            pubkeys: pubkeys,
            network: this.network
        }
    )

    // A bare multisig output is larger than a P2PKH, so the P2PKH
    // dust floor (this.dustAmount, read per network from the coin
    // bundle's dustThreshold: BTC 546, LTC 5460, DOGE 100000) is
    // below the node's relay dust threshold and the broadcast is
    // rejected with {"code":-26,"message":"dust"}. Never hard-code a
    // flat 546 here: DOGE shares this path at 100000. Size the floor
    // from the actual output script using Bitcoin Core's dust formula:
    // (output_bytes + spend_input_bytes) * 3 sat/byte. The spend cost
    // assumes a 148-byte P2PKH-style input. For standard 1-of-3
    // compressed-key scripts (105 bytes) this is ~786 sat.
    let bareMultisigDust = Math.ceil((8 + 1 + multisignScript.output.length + 148) * 3)
    let multisigOutputValue = Math.max(finalDust, bareMultisigDust)

    psbt.addOutput({
        script: multisignScript.output,
        value: multisigOutputValue
        })
    // Account for the data output's value so change is not over-credited
    // (otherwise total outputs exceed total inputs and the tx is invalid).
    outputSatoshis += BigInt(multisigOutputValue)

    estimatedTxSize = estimatedTxSize
        + TxSizeEstimator.estimateMultisignOutput()

    Object.assign(build, { obfuscatedData, outputSatoshis, estimatedTxSize })
}

function emitEnvelopeCommit(build, nextDataBuffer){
    let { preparedData, change, pubkey, feePerBytes, finalDust, psbt, outputSatoshis, estimatedTxSize,
        revealPrefund, envelopeContext } = build
    // nextDataBuffer IS the whole envelope tapscript (single
    // element). One commit output carries it; the reveal is
    // built after input selection, once the commit txid exists.
    const internalPubkey = preparedData["internalPubkey"]
    const commitPayment = bitcoin.payments.p2tr({
        internalPubkey,
        scriptTree: { output: nextDataBuffer },
        network: this.network
    })

    // The reveal's only funding is the commit output, so its
    // value must prefund the reveal's miner fee plus a change
    // output at the dust floor (the reveal must carry at least
    // one output; change doubles as the CPFP handle), plus
    // the stripped-size floor pad where the chain demands one
    // (LTC: a reveal whose only output is small sits under
    // minStandardTxNonWitnessSize, exactly like the P2WSH
    // reveal; the payload lives in the witness and does not
    // count toward stripped size).
    const revealChangeAddress = change || resolveCallerAddress(pubkey, this.network)
    const revealChangeOutBytes = TxSizeEstimator.estimateOutputSizeForAddress(revealChangeAddress, this.network)
    const envStrippedFloor = this.network.minStandardTxNonWitnessSize
    const revealPadNeeded = !!(envStrippedFloor && (10 + 41 + revealChangeOutBytes) < envStrippedFloor)
    const revealOutputsBytes = revealChangeOutBytes + (revealPadNeeded ? revealChangeOutBytes : 0)
    const revealVsize = TxSizeEstimator.estimateEnvelopeRevealTx(nextDataBuffer.length, revealOutputsBytes, envStrippedFloor)
    let revealFee = Math.trunc(revealVsize * feePerBytes * SATOSHI_UNIT)
    if (revealFee < finalDust){
        revealFee = finalDust
    }
    const commitValue = revealFee + this.dustAmount + (revealPadNeeded ? this.dustAmount : 0)

    revealPrefund = {
        outputIndex: psbt.txOutputs.length,
        revealSize: revealVsize,
        revealFee
    }

    psbt.addOutput({
        script: commitPayment.output,
        value: commitValue
    })
    outputSatoshis = outputSatoshis + BigInt(commitValue)
    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateTaprootOutput()

    envelopeContext = {
        internalPubkey,
        envelopeScript: nextDataBuffer,
        commitPayment,
        commitValue,
        revealFee,
        revealPadNeeded,
        revealChangeAddress
    }
    Object.assign(build, { revealPrefund, outputSatoshis, estimatedTxSize, envelopeContext })
}

function emitCustomOutputs(build){
    let { p2shHash, isP2shFamily, customOutputs, psbt, outputSatoshis, estimatedTxSize } = build
    // Process custom outputs (e.g., COINPay native coin payment outputs, or
    // the native-fee protocol-fee output). On a P2SH/P2WSH FUNDING tx
    // (p2shHash null) these are NOT emitted here: their value was folded into
    // the funding outputs above so the reveal can pay them, and the reveal
    // (p2shHash set) emits them. Emitting here too would put the output on the
    // wrong tx (the indexer reads the reveal) and double-pay. Single-tx
    // encodings and the reveal itself fall through and emit normally.
    const skipCustomOutputs = !p2shHash && isP2shFamily
    if (!skipCustomOutputs && customOutputs && Array.isArray(customOutputs)) {
        for (let i = 0; i < customOutputs.length; i++) {
            const output = customOutputs[i]
            const outputValue = parseSatoshiAmount(output.value, `customOutputs[${i}].value`, { allowBig: true })
            // A 0-sat caller output is consensus-valid but relay-rejected as
            // dust, so the caller signs an unbroadcastable PSBT. Reject it at
            // the effector too (not just the validator boundary), matching the
            // native-fee output which is always positive (guarded at injection
            // above), so this never rejects a legitimate sub-dust FEE_DESTINATION
            // value. Interim safe rule: reject only value <= 0, not a full
            // per-network dust floor.
            if (outputValue <= 0) {
                throw new RangeError(`customOutputs[${i}].value must be a positive integer (satoshis)`)
            }
            psbt.addOutput({
                address: output.address,
                value:   outputValue
            })
            outputSatoshis += BigInt(outputValue)
            estimatedTxSize += 43 // Taproot output size estimate (most expensive)
        }
    }
    Object.assign(build, { outputSatoshis, estimatedTxSize })
}

module.exports = { prepareDataChunks, priceRevealCustomOutputs, initEmissionState, emitDataOutputs, emitCustomOutputs }
