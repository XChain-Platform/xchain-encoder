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
const { MAX_COMPILED_ACTION_DATA_LENGTH, ENVELOPE_MAX_PAYLOAD, validateDataParam, validateActionPushDecodability, unknownActionName } = require('../../common/validator')
const { compressPayloadForAction } = require('../../build/compression')
const { Encoding } = require('../constants.js')
const { ensureEccLib } = require('../script_amount_helpers.js')
const { defaultCompressionEnabled } = require('../request_resolution.js')

// The caller's payload as handed over: wire-safety re-checks, the ACTION-name
// read, and the fee-quote output injected ahead of every other output.
function checkPayloadInput(build){
    let { data, rawData, feeQuote, customOutputs } = build
    // Re-check what the wire encodings can actually carry, for direct library
    // callers. api.js runs validateAll before createTransaction, but
    // createTransaction is a supported library entry point of its own and
    // reaches this builder with no validator in front of it, so the
    // round-trip guard existed on one surface only: a `rawData` code unit
    // above U+00FF was truncated to its low byte by the Latin-1 conversion
    // below, and the compiled-size ceiling cannot see it because the length
    // is unchanged. Same idiom as the per-entry UTXO, txid, fee and address
    // re-validation further down.
    //
    // Runs BEFORE compression on purpose: the compression pass itself does
    // Buffer.from(rawData,'binary'), so a check placed after it would measure
    // bytes the truncation already produced.
    //
    // STRING inputs only, deliberately. The corruption is a property of the
    // string-to-wire conversion; a caller handing the builder a Buffer is
    // copied byte-for-byte and loses nothing, so refusing it here would
    // impose RPC-surface argument-shape policy on library callers rather
    // than close a data-loss path.
    if (typeof data === 'string') validateDataParam(data, 'data')
    if (typeof rawData === 'string') validateDataParam(rawData, 'rawData')

    // The ACTION-name recognition check has the same one-surface problem, and a
    // different answer. validateAll REFUSES an unrecognized leading token on the
    // JSON-RPC path (validator.js), so only a direct library caller reaches the
    // compiler with one: the transaction compiles, pays a real miner fee, and the
    // decoder drops the ACTION with nothing reported back. The compiled-size
    // checks cannot catch it, because an unknown name is an ordinary length.
    //
    // REPORTED, not refused, matching the rawDataOnlyPayload advisory below
    // rather than the RPC gate. createTransaction is a general PSBT builder as
    // well as an ACTION builder, and its supported shapes include a payload that
    // is not an XChain ACTION at all; refusing here would withdraw that contract
    // from every library and browser-bundle caller to close a silence, and the
    // silence is the whole of the harm. The fee-payer learns before it signs,
    // which needs no acceptance change.
    //
    // Read BEFORE compression, on the caller's own bytes, which is the surface
    // validateAll measures; the compression pass rewrites `data` afterwards.
    // Buffer inputs read too, unlike the latin-1 re-check above: that one is
    // string-only because a Buffer loses nothing in the conversion, while the
    // decoder tokenizes the compiled push whatever shape the caller handed over.
    const unknownAction = unknownActionName(data)

    // If feeQuote is provided, inject it as a custom output
    if(feeQuote && feeQuote.address && feeQuote.amount > 0){
        if(!customOutputs) customOutputs = [];
        customOutputs.push({ address: feeQuote.address, value: feeQuote.amount });
    }
    Object.assign(build, { unknownAction, customOutputs })
}

function* compressPayload(build){
    let { compress, data, rawData } = build
    // Transparent FILE payload compression, ON by default.
    //
    // Runs HERE, before the payload buffers are assembled, so everything
    // downstream sees the bytes that will actually be written: the per-encoding
    // ceiling check below, the size estimator, the fee quote, and the encoding
    // selection all price the compressed payload rather than the caller's
    // original. The estimator must run after compression so quotes reflect real
    // bytes.
    //
    // The encoder always attempts compression of rawData and emits the compressed
    // form only when smaller. `compress` is TRI-STATE: true/false are the caller's
    // explicit choice, while null/undefined take the deployment default.
    //
    // The distinction is not cosmetic. An EXPLICIT request that cannot be
    // honoured throws, because the caller asked for something this payload cannot
    // have. The DEFAULT pass runs over every action, most of which are not
    // compressible FILEs, so the same conditions are ordinary facts and the
    // payload rides raw (see compression.js's `explicit` option). Without that
    // split, turning the default on would break every SEND carrying rawData.
    //
    // ROLLOUT: compression is consensus-safe but client-coordinated. An old reader
    // serves a compressed FILE as deflated garbage, so reader support must be
    // deployed everywhere BEFORE an encoder carrying this default.
    // XCHAIN_COMPRESSION_DEFAULT=0 is the deploy-time lever that lets the code
    // release and the behaviour change land separately.
    const compressExplicit = (compress === true || compress === false)
    const compressEnabled = compressExplicit ? compress : defaultCompressionEnabled()
    let compressionResult = null
    if (compressEnabled && rawData != null){
        let originalBuffer = Buffer.from(rawData, 'binary')
        compressionResult = (yield compressPayloadForAction(data, originalBuffer, { explicit: compressExplicit }))
        if (compressionResult.compressed){
            // Both halves move together: the marker and the bytes it
            // describes. They must never be assigned separately.
            data = compressionResult.data
            rawData = compressionResult.rawData.toString('binary')
        }
    }
    Object.assign(build, { data, rawData, compressionResult })
}

// The compiled action stream every encoding carries, after the push-shape guard.
function compilePayload(build){
    let { data, rawData } = build
    // Refuse the single-byte shapes bitcoin.script.compile canonicalizes into
    // a bare opcode, for direct library callers. The same reason as the
    // round-trip guard at the head of this method: validateAll runs this
    // check on the JSON-RPC path only, so a library call with rawData '\x05'
    // compiled to OP_5 and the decoder dropped the byte off a fee-paid
    // transaction (its element test is Buffer.isBuffer).
    //
    // Runs AFTER compression on purpose, unlike the guard above: this one
    // measures the bytes that are about to be compiled, so a lone minimal-op
    // byte that compression rewrote into a multi-byte payload is correctly
    // allowed through and a payload compression rewrote is covered too.
    //
    // The empty-data shapes stay buildable: isMinimalOpSingleByte excludes
    // the empty buffer, so the payment-only and rawData-only contracts are
    // untouched and the flag-day decision they belong to is not pre-empted
    // here (see the rawDataOnlyPayload advisory below).
    //
    // Runs on Buffer inputs too, unlike the latin-1 guard above. That guard
    // is string-only because a Buffer is copied byte for byte and loses
    // nothing in the conversion; canonicalization is a property of the
    // COMPILED push, so a byte-for-byte-copied one-byte Buffer loses
    // everything. validateActionPushDecodability normalizes either shape.
    validateActionPushDecodability(data, rawData)

    // `data` is optional (openrpc.json create_tx data.required=false) and
    // validateAll passes null through when omitted, but Buffer.from(null,'utf8')
    // throws a Node TypeError, so a valid data-omitted request (e.g. a
    // payment-only tx built from customOutputs) would fail with an opaque
    // internal error. A missing payload defaults to '', identical to the
    // already-supported empty-string case, which compiles cleanly downstream.
    let dataBuffer = Buffer.from(data == null ? '' : data, 'utf8')
    let dataToCompile = [dataBuffer]

    if (rawData != null){
        // 'binary' (Latin-1) preserves bytes 0-255 one-to-one. 'utf8' would
        // corrupt arbitrary binary payloads (e.g. AES-GCM ciphertext for
        // token-gated FILEs, and deflate-raw output). Existing ASCII callers
        // like base64-encoded file bytes are byte-identical under both.
        let rawDataBuffer = Buffer.from(rawData, 'binary')
        dataToCompile.push(rawDataBuffer)
    }

    let finalDataBuffer = bitcoin.script.compile(dataToCompile)
    Object.assign(build, { dataBuffer, finalDataBuffer })
}

function classifyPayload(build){
    let { dataBuffer, rawData } = build
    // Does this transaction carry an XChain ACTION at all?
    //
    // `data` being optional already meant "payment-only tx" in the wire
    // contract, but the emission path below still wrote a nulldata output
    // for it: the empty payload compiled to an OP_0 push, got the 4-byte
    // magic word prepended, and shipped as a magic-word-only OP_RETURN
    // carrying nothing. That is a real cost (a wasted output, and a
    // transaction that announces itself as XChain while containing no
    // action) paid by every plain native-coin payment the wallet sends.
    // A payment with nothing to say should look like an ordinary payment.
    const hasActionPayload = dataBuffer.length > 0 || rawData != null

    // rawData with no `data` compiles to an OP_0-led payload, and every shipped
    // decoder blanks that stream and never reads the trailing push (the arbiter gate
    // in xchain-decoder/src/XChainDecoder.js, which counts it and logs it but leaves
    // ACCEPTANCE unchanged on purpose). So the transaction confirms, the fee is paid,
    // and the payload is never indexed as an ACTION.
    //
    // Reported, not refused. Whether this wire shape becomes readable end to end is a
    // cross-service flag-day decision that governs the decoder gate and validator.js
    // together (see isMinimalOpSingleByte), so refusing it here would settle half of a
    // joint decision unilaterally and strand the decoder half when it lands. Telling
    // the fee-payer before it signs needs no acceptance change at all. Drop this when
    // the flag day lands.
    const rawDataOnlyPayload = dataBuffer.length === 0 && rawData != null
    Object.assign(build, { hasActionPayload, rawDataOnlyPayload })
}

// The encoding this build uses, and the per-encoding ceilings it must fit.
function chooseEncoding(build){
    let { encoding, finalDataBuffer, compressedPubKey, options } = build
    // Size-aware encoding selection, behind the caller's explicit AUTO opt-in.
    // Runs HERE: after compression, so it prices the bytes that will really be
    // written, and before the ceiling check, so an over-cap payload is refused
    // against the lane that was actually chosen.
    //
    // Deliberately NOT the same thing as the legacy `!encoding` fallback in
    // prepareData (OP_RETURN, else P2SH), which stays exactly as shipped: a
    // caller who passes no encoding must keep getting today's bytes, because
    // auto-selecting TAPROOT changes the response from one PSBT to a
    // commit/reveal pair and no existing caller is ready for that.
    if (encoding === Encoding.AUTO){
        encoding = this.selectEncoding(finalDataBuffer.length, compressedPubKey, options)
    }

    // Enforce the compiled-push ceiling the indexing decoder applies, PER
    // ENCODING: every legacy lane keeps the 8,192-byte
    // MAX_ACTION_DATA_LENGTH (the decoder measures the compiled on-chain
    // push and silently drops anything larger, so reject at encode time);
    // only an explicit TAPROOT request gets the envelope ceiling. Note the
    // two constants measure slightly different things: the legacy guard is
    // framing-inclusive of the single on-chain push, the envelope ceiling
    // measures the reassembled payload (this same compiled stream) while
    // the envelope's own 520-byte push framing rides outside it.
    const compiledCeiling = (encoding === Encoding.TAPROOT) ? ENVELOPE_MAX_PAYLOAD : MAX_COMPILED_ACTION_DATA_LENGTH
    if (finalDataBuffer.length > compiledCeiling) {
        throw new RangeError(`Payload too large: compiled size ${finalDataBuffer.length} bytes exceeds maximum ${compiledCeiling} bytes (${encoding === Encoding.TAPROOT ? 'TAPROOT envelope payload ceiling' : 'compiled on-chain ACTION push'})`)
    }

    if (encoding === 'P2WSH' && this.network.supportsSegwit === false) {
        throw new TypeError('P2WSH encoding is not supported on this network (no segwit support)')
    }
    Object.assign(build, { encoding })
}

function* checkEnvelopeEncoding(build){
    let { encoding, p2shHash } = build
    // Envelope availability is a property of the network definition:
    // DOGE has no segwit, hence no Taproot; same gate, same error shape as
    // P2WSH. The p2shHash guard exists for direct library callers (the API
    // validator already rejects it): TAPROOT is a single-call flow that
    // returns the commit/reveal pair together, never a second reveal call.
    if (encoding === Encoding.TAPROOT) {
        if (this.network.supportsSegwit === false) {
            throw new TypeError('TAPROOT encoding is not supported on this network (no segwit support)')
        }
        if (p2shHash) {
            throw new TypeError('TAPROOT encoding does not use the p2shHash reveal flow; one create_tx call returns the commit and reveal PSBTs together')
        }
        // Segwit support is NOT sufficient. Below the network's recognition
        // height every decoder ignores an envelope reveal, so building one here
        // would hand the caller a valid, broadcastable, correctly signed pair for
        // an action that will never exist, and they pay real coin for it. The
        // decoder's refusal is silent and correct, so nothing downstream can
        // detect the loss; this is the only place it can be caught.
        yield this.assertEnvelopeRecognized()
        ensureEccLib()
    }
}

module.exports = { checkPayloadInput, compressPayload, compilePayload, classifyPayload, chooseEncoding, checkEnvelopeEncoding }
