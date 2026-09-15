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

const {
    OP_RETURN_PUSH_OVERHEAD,
    VALID_ACTION_NAMES,
    ACTION_ALIASES,
    MAX_COMPILED_ACTION_DATA_LENGTH,
    MAX_OP_RETURN_COMPILED_LENGTH,
    ENVELOPE_MAX_PAYLOAD,
    VALID_ENCODINGS
} = require('./constants')
const { firstNonLatin1 } = require('./value_checks')

// Gate `data` and `rawData` on what their wire encodings can actually carry, not
// just on being strings. prepareData converts data with Buffer.from(data,'utf8')
// and rawData with Buffer.from(rawData,'binary') (XChainEncoder.js), and neither
// conversion is reversible for every JS string: an unpaired surrogate becomes
// U+FFFD under utf8, and a code unit above U+00FF is truncated to its low byte
// under latin-1. Accepting those silently mutates a fee-paid payload into bytes
// the decoder can never reconstruct into the value that was validated, so refuse
// them here instead. RangeError so api.js maps it to -32602 invalid-params. This
// rejects only non-roundtrippable inputs, leaving faithfully encoded inputs
// unchanged.
function validateDataParam(value, fieldName) {
    if (value == null) return null
    if (typeof value !== 'string') {
        throw new TypeError(`${fieldName} must be a string`)
    }
    if (fieldName === 'rawData') {
        // Latin-1 wire: every code unit must fit one byte.
        const bad = firstNonLatin1(value)
        if (bad !== -1) {
            throw new RangeError(`${fieldName} contains a code point above U+00FF at index ${bad} that cannot be encoded as a latin-1 byte`)
        }
    } else if (!value.isWellFormed()) {
        // UTF-8 wire: an unpaired surrogate would be replaced with U+FFFD.
        throw new RangeError(`${fieldName} is not well-formed Unicode (unpaired surrogate) and cannot round-trip through UTF-8`)
    }
    return value
}

// Size of a single script push once bitcoin.script.compile adds its length
// prefix: a direct push opcode for <=75 bytes, OP_PUSHDATA1 (+2) for <=255, or
// OP_PUSHDATA2 (+3) beyond that. Mirrors how prepareData compiles data/rawData.
// Deliberately has no OP_PUSHDATA4 band: this formula is pinned byte-for-byte
// against the decoder's identical copy by xchain-decoder's
// compiledPushSizeConformance test, so a band added on one side alone diverges
// the pair. Callers measuring a push that can reach 65,536 bytes correct for it
// themselves (envelopePushSize below). Only the OP_PUSHDATA2 branch names a
// constant: the +1/+2 branches are different opcodes that OP_RETURN_PUSH_OVERHEAD
// does not describe.
function compiledPushSize(byteLength) {
    if (byteLength <= 75)  return byteLength + 1   // direct push opcode
    if (byteLength <= 255) return byteLength + 2   // OP_PUSHDATA1
    return byteLength + OP_RETURN_PUSH_OVERHEAD    // OP_PUSHDATA2
}

// compiledPushSize with the OP_PUSHDATA4 band restored: bitcoin.script.compile
// frames a push of >= 65,536 bytes with a 4-byte length prefix (+5), not the
// 2-byte one (+3) that compiledPushSize stops at. Only reachable under the
// 390,000-byte TAPROOT/AUTO envelope ceiling, where a single rawData push
// routinely clears 65,535 bytes; under the 8,192-byte legacy ceiling such a push
// is refused on either model, so applying the correction unconditionally costs
// nothing and keeps one rule to reason about.
function envelopePushSize(byteLength) {
    return compiledPushSize(byteLength) + (byteLength > 0xffff ? 2 : 0)
}

// True only for a 1-byte buffer whose value bitcoinjs canonicalizes to a bare
// numeric opcode (OP_1..OP_16 / OP_1NEGATE). The empty-buffer -> OP_0 case is
// EXCLUDED here because a missing/empty `data` is an intentional, contract-documented shape (an empty
// data-only push is a payment-only / no-ACTION tx, and an empty data + rawData
// is the deliberately-supported rawData-only request; see validateCombinedDataLength
// and the openrpc create_tx data.required=false contract). Restoring the
// rawData-only wire shape end-to-end is a decoder-side (consensus) acceptance
// change owned by the cross-service flag-day spec, not an encoder refusal.
function isMinimalOpSingleByte(buf) {
    if (buf.length !== 1) return false
    const b = buf[0]
    return (b >= 0x01 && b <= 0x10) || b === 0x81
}

// Reject a `data` or `rawData` value that is a single minimal-opcode-range byte
// (0x01-0x10 or 0x81). bitcoin.script.compile canonicalizes such a lone byte to
// a bare opcode, so bitcoin.script.decompile returns an integer (not a Buffer)
// for that element and the decoder's arbiter gate silently discards it
// (XChainDecoder.js: !Buffer.isBuffer(decompiledData[0]) blanks the payload; a
// non-Buffer decompiledData[1] drops rawData). Real ACTION payloads are
// multi-byte text so this shape is degenerate, but it is fee-paid silent data
// loss, so refuse it at validate time. Throws RangeError so api.js maps it to a
// -32602 invalid-params classification. The empty-data cases are intentionally
// out of scope here (see isMinimalOpSingleByte).
function validateActionPushDecodability(data, rawData) {
    if (data != null && isMinimalOpSingleByte(Buffer.from(data, 'utf8'))) {
        throw new RangeError(
            'data must not be a single byte in the minimal-opcode range (0x01-0x10, 0x81); ' +
            'it compiles to a bare opcode that the decoder discards, silently dropping the ACTION')
    }
    if (rawData != null && isMinimalOpSingleByte(Buffer.from(rawData, 'binary'))) {
        throw new RangeError(
            'rawData must not be a single byte in the minimal-opcode range (0x01-0x10, 0x81); ' +
            'it compiles to a bare opcode that the decoder discards, silently dropping rawData')
    }
}

// Reject a `data` value whose leading ACTION token (the text before the first
// '|', or the whole string if no '|' is present) is neither a canonical
// action name nor a known alias. Mirrors exactly how the decoder tokenizes:
// XChainDecoder.js does `decodedData.split("|")[0]` then
// `ACTION_ALIASES[rawActionName] ?? rawActionName` against VALID_ACTION_NAMES,
// at both the confirmed-block and mempool gate sites. Without this
// check, a typoed or not-yet-deployed ACTION name compiles into a valid,
// fee-paid, broadcast transaction that the decoder then silently no-actions
// (parseErrors++, decodedData = "" / tx skipped) with no error back to the
// caller. Throws RangeError so api.js maps it to a -32602 invalid-params
// classification, matching the validateActionPushDecodability convention.
// An empty/absent `data` intentionally skips this check: it has no leading
// ACTION token to validate and the decoder never reaches its own name gate
// for a zero-length payload either (see the `parseResult["data"].length > 0`
// guard around the decoder's gate).
//
// The recognition test itself lives in unknownActionName below, so the two
// surfaces that need it share one tokenizer: this validator REFUSES on the
// JSON-RPC path, and XChainEncoder._buildTransaction REPORTS on the library
// path, where a generic `data` payload is a supported shape.
function validateActionName(data) {
    const rawActionName = unknownActionName(data)
    if (rawActionName == null) return
    throw new RangeError(
        `data has unknown ACTION name '${rawActionName.slice(0, 32)}'; ` +
        'the decoder rejects any leading token that is not a canonical action ' +
        'name or alias, silently dropping the ACTION on a fee-paid transaction')
}

// The leading ACTION token of `data` when the decoder would NOT recognize it,
// else null. Same tokenization as the decoder and as validateActionName's own
// contract above; splitting it out lets a caller that must stay buildable
// report the token instead of throwing on it.
//
// Buffer `data` reads too, because the library builder accepts that shape and
// the compiler copies those bytes verbatim, so the decoder tokenizes the same
// leading token whichever shape arrived. Every canonical name and alias is
// ASCII, so decoding the buffer never turns a recognized name into an
// unrecognized one. A value that is neither a string nor a Buffer reads as null
// and is left to the shape errors downstream.
function unknownActionName(data) {
    if (data == null || data.length === 0) return null
    if (typeof data !== 'string' && !Buffer.isBuffer(data)) return null
    const rawActionName = (Buffer.isBuffer(data) ? data.toString('utf8') : data).split('|')[0]
    const actionName = ACTION_ALIASES[rawActionName] ?? rawActionName
    return VALID_ACTION_NAMES.has(actionName) ? null : rawActionName
}

// MEASURAND: the CALLER'S bytes, before compression, deliberately.
//
// api.js runs validateAll on the raw params, and XChainEncoder.js's transparent
// FILE compression rewrites both `data` and `rawData` afterwards, so this
// pre-check and the compiled-size ceiling in _buildTransaction measure two
// different byte streams. That is the contract, not an oversight: the same
// pre-compression cap is what xchain-sdk documents (protocol/constants.js
// MAX_ACTION_DATA_LENGTH) and what xchain-wallet gates uploads on
// (flows/fileSizeLimits.js), so a caller sizes a payload the same way on all
// three surfaces without knowing whether the encoder it is talking to has
// compression enabled (XCHAIN_COMPRESSION_DEFAULT is a deploy-time lever this
// module cannot see, the same way it cannot see network.supportsSegwit).
//
// Two consequences, both fail closed behind the compiled-size ceiling:
//   - compression cannot rescue an oversize payload. A FILE whose RAW bytes
//     exceed the ceiling is refused here as -32602 even where deflate would
//     have fitted it. Raising that is a cross-repo contract change (encoder +
//     SDK + wallet together), never an encoder-only relaxation.
//   - a payload within ~8 bytes of the ceiling can still fail post-compression:
//     compression.js keeps a result that is smaller by as little as one byte
//     while withCompressionField pads the action string out to the COMPRESSION
//     field. Those land as the builder's -32603 rather than this -32602.
//
// XChainEncoder.js's "everything downstream prices the bytes that will actually
// be written" is about the passes that run AFTER compression; this one runs
// before it. The compiled-size ceiling still runs ahead of the UTXO fetch, so
// what a deferred rejection costs is the error CODE, not reservation work.
function validateCombinedDataLength(data, rawData, encoding) {
    if (data == null && rawData == null) return
    // createTransaction defaults a missing `data` to '' and still compiles it
    // as a push (OP_0, 1 byte), so a rawData-only request must be measured
    // here too; skipping it only shifted the rejection to the compiled-size
    // ceiling in createTransaction with a -32603 internal error instead of
    // this pre-check's -32602 invalid-params classification.
    const dataBytes = data != null ? Buffer.byteLength(data, 'utf8') : 0
    // Match XChainEncoder.js: rawData is bytes-as-string (Latin-1), so the
    // on-chain byte count is the string length, not the UTF-8 encoding length.
    const rawBytes = rawData != null ? Buffer.byteLength(rawData, 'binary') : 0
    // When both fields are present, prepareData compiles them as two separate
    // pushes (bitcoin.script.compile([utf8Buffer, rawDataBuffer])), so each push
    // carries its own length-prefix overhead. Summing the raw byte counts would
    // undercount the on-chain size and let dual-push payloads slip past this
    // pre-check only to fail the compiled-size ceiling later in createTransaction.
    // envelopePushSize, not compiledPushSize: this sum is compared against the
    // 390,000-byte envelope ceiling below, and _buildTransaction refuses on the
    // REAL compiled buffer, so a push framed with OP_PUSHDATA4 must be counted
    // the way bitcoin.script.compile frames it or the two ceilings disagree by
    // 2 bytes per large push and a payload lands as -32603 instead of -32602.
    const compiled = envelopePushSize(dataBytes) + (rawData != null ? envelopePushSize(rawBytes) : 0)
    // Per-encoding ceiling. "TAPROOT" and "AUTO" both get the
    // envelope ceiling; every other value (including an OMITTED encoding) keeps
    // the legacy ceiling, because legacy decoders silently drop anything
    // over 8,192 compiled bytes.
    //
    // AUTO is here because selectEncoding (XChainEncoder.js) resolves an AUTO
    // request to TAPROOT once the payload outgrows OP_RETURN and the caller
    // affirms signerSupportsTapscript with a compressedPubKey. This validator is
    // network-agnostic (it cannot see network.supportsSegwit) and runs before
    // that resolution, so it can only apply the WIDEST ceiling any AUTO
    // resolution could legitimately use, and let _buildTransaction re-check the
    // resolved carrier. Consequence: an AUTO request that resolves to a legacy carrier
    // over 8,192 bytes is refused by the builder (-32603) rather than here
    // (-32602). Both fail closed. Note an OMITTED encoding is NOT AUTO: it keeps
    // prepareData's legacy OP_RETURN-else-P2SH fallback and its legacy ceiling.
    const wideCeiling = (encoding === 'TAPROOT' || encoding === 'AUTO')
    const ceiling = wideCeiling ? ENVELOPE_MAX_PAYLOAD : MAX_COMPILED_ACTION_DATA_LENGTH
    if (compiled > ceiling) {
        throw new RangeError(`Combined compiled payload (${compiled} bytes) exceeds maximum (${ceiling}${wideCeiling ? ', the TAPROOT envelope payload ceiling' : ''})`)
    }
    // When the caller EXPLICITLY requested OP_RETURN, apply the far tighter 76-byte
    // single-output ceiling here rather than letting the request run the whole
    // UTXO-selection/reservation path and throw post-compile in prepareData (which
    // api.js then mis-classifies as -32603 internal instead of -32602 invalid-params).
    // Only when encoding is explicitly 'OP_RETURN': an omitted encoding must NOT be
    // rejected here, or it would break prepareData's automatic P2SH fallback for
    // larger payloads. prepareData remains the arbiter/backstop.
    if (encoding === 'OP_RETURN' && compiled > MAX_OP_RETURN_COMPILED_LENGTH) {
        throw new RangeError(
            `OP_RETURN encoding requires compiled payload <= ${MAX_OP_RETURN_COMPILED_LENGTH} bytes; ` +
            `got ${compiled}. Use P2SH for larger payloads.`)
    }
}

function validateEncoding(encoding) {
    if (encoding == null) return null
    if (typeof encoding !== 'string' || !VALID_ENCODINGS.has(encoding)) {
        throw new TypeError(`Invalid encoding: "${encoding}". Valid values: ${[...VALID_ENCODINGS].join(', ')}`)
    }
    return encoding
}

module.exports = {
    validateDataParam,
    compiledPushSize,
    envelopePushSize,
    isMinimalOpSingleByte,
    validateActionPushDecodability,
    validateActionName,
    unknownActionName,
    validateCombinedDataLength,
    validateEncoding
}
