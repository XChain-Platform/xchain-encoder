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
 * This file adds each selected UTXO to the funding PSBT as an input
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib')
const TxSizeEstimator = require('../../build/tx_size_estimator')
const { OperationalError, ParamRangeError } = require('../../build/errors')
const { matchingLegacyRedeemScript } = require('./legacy_p2sh.js')

// Psbt.addInput re-checks every input already in the PSBT, re-parsing each witnessUtxo
// script to test for taproot, so N inputs cost time in N squared: about 2.6 s at the
// 500-input cap, all on the event loop the readiness probe shares. Selection therefore
// adds each outpoint bare (hash, index, sequence; duplicates still refuse at once) and
// attaches the rest of its fields when selection ends, or sooner when a check must read
// them, which keeps nearly every re-check on bare fields and the cost near linear. The
// PSBT bytes do not change.
function createInputQueue(psbt){
    const pending = []
    return {
        add(input){
            const { hash, index, sequence, ...fields } = input
            psbt.addInput({ hash, index, sequence })
            pending.push({ inputIndex: psbt.data.inputs.length - 1, fields })
        },
        flush(){
            for (const { inputIndex, fields } of pending) psbt.updateInput(inputIndex, fields)
            pending.length = 0
        }
    }
}

// Refuses a UTXO whose stated value differs from its output in the fetched previous tx.
// A legacy sighash does not commit to input amounts, so an understated value would sign
// and the hidden difference would go to miners, past fee guards that read the same figure.
function assertPrevOutValueMatches(prevTx, utxo, fetchedFromTracker){
    const outpoint = `${utxo.txid}:${utxo.vout}`
    const prevOut = prevTx ? prevTx.outs[utxo.vout] : null
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

// Fetches a parent transaction once per build and parses it once: inputs sharing a parent
// (a batch paid out of one transaction) otherwise cost a node round trip and a parse each.
// A failed fetch is not memoized. The value check still runs per outpoint on the cached parse.
function* fetchPrevTx(connector, txid, memo){
    let entry = memo.get(txid)
    if (!entry){
        const hex = yield connector.getTransactionHex(txid)
        let tx = null
        try {
            tx = bitcoin.Transaction.fromHex(hex)
        } catch (err) {
            tx = null
        }
        entry = { hex, tx }
        memo.set(txid, entry)
    }
    return entry
}

// nestedRedeem is the P2WPKH redeem script of a P2SH-P2WPKH input, signed as segwit.
function* addSelectedInput(inputQueue, nextUtxo, utxoSequence, attachPrevTx, estimatedTxSize, inputSatoshis, fetchedFromTracker, nestedRedeem, prevTxMemo = new Map()){
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
            const prev = yield* fetchPrevTx(this.connector, nextUtxo.txid, prevTxMemo)
            // Check the amount too: a hardware signer reads it from these bytes.
            assertPrevOutValueMatches(prev.tx, nextUtxo, fetchedFromTracker)
            nextInput.nonWitnessUtxo = Buffer.from(prev.hex, 'hex')
        }
        inputQueue.add(nextInput)
        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
        inputSatoshis = inputSatoshis + BigInt(nextUtxo.value)
    } else {
        const prev = yield* fetchPrevTx(this.connector, nextUtxo.txid, prevTxMemo)
        // Check the stated amount against the node's copy before it enters the fee math.
        assertPrevOutValueMatches(prev.tx, nextUtxo, fetchedFromTracker)
        let nextInput = {
            hash: nextUtxo.txid,
            index: nextUtxo.vout,
            sequence: utxoSequence,
            nonWitnessUtxo: Buffer.from(prev.hex, 'hex')
        }
        const redeemScript = matchingLegacyRedeemScript(nextUtxo)
        if (redeemScript) nextInput.redeemScript = redeemScript
        inputQueue.add(nextInput)
        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
        inputSatoshis = inputSatoshis + BigInt(nextUtxo.value)
    }
    return { estimatedTxSize, inputSatoshis }
}

module.exports = { createInputQueue, addSelectedInput }
