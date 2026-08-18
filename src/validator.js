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
 * XChain Encoder - Input Validator
 *
 * Centralized validation for all createTransaction parameters.
 * Every function throws TypeError or RangeError on invalid input,
 * or returns the (possibly coerced) valid value.
 *
 ********************************************************************/

// Maximum *compiled* on-chain ACTION push, in bytes. Must equal the decoder's
// MAX_ACTION_DATA_LENGTH: a transaction whose compiled push exceeds this is
// silently dropped by every indexing node. Canonical source of truth:
// xchain-documentation/protocol/constants.js (MAX_ACTION_DATA_LENGTH). The
// cross-service regression suite asserts these stay equal.
const MAX_COMPILED_ACTION_DATA_LENGTH = 8192
// Length prefix a single OP_PUSHDATA2 push prepends to a >=256-byte payload
// (1 opcode + 2 length bytes). The widest single raw push is measured against
// the compiled ceiling with this prefix included. Canonical source of truth:
// xchain-documentation/protocol/constants.js (OP_RETURN_PUSH_OVERHEAD). The
// cross-service regression suite pins this local copy by name against that
// declaration, so the name must match exactly, not just the value.
const OP_RETURN_PUSH_OVERHEAD = 3
// Largest raw single-push payload that still fits the compiled on-chain ceiling:
// a raw payload of N bytes (N >= 256) compiles to N + 3 once the OP_PUSHDATA2
// prefix is added, so 8189 + 3 == 8192. Derived from the compiled ceiling so the
// relationship is explicit (value is still 8189). Retained as the documented
// single-push reference; validateCombinedDataLength derives the actual per-push
// ceiling via compiledPushSize so that dual-push payloads are measured against
// the compiled ceiling directly rather than this single-push approximation.
// Kept and exported because the test suite pins its value.
const MAX_DATA_BYTES = MAX_COMPILED_ACTION_DATA_LENGTH - OP_RETURN_PUSH_OVERHEAD
// Explicit-encoding OP_RETURN ceiling: a single nulldata output is 80 bytes, of
// which the 4-byte "XCHN" magic word is reserved, leaving 76 bytes of compiled
// payload. Mirrors XChainEncoder.prepareData (OP_RETURN_SIZE - MAGIC_WORD length),
// which stays the arbiter/backstop; measured pre-compile here only when the caller
// explicitly requests encoding:"OP_RETURN" so an oversize request is rejected as
// -32602 invalid-params before any UTXO reservation, instead of failing post-compile
// as a -32603 internal error. The compiled value this is compared against is
// exactly finalDataBuffer.length in createTransaction (same compiledPushSize sum).
const OP_RETURN_OUTPUT_SIZE = 80
const OP_RETURN_MAGIC_WORD_LENGTH = 4
const MAX_OP_RETURN_COMPILED_LENGTH = OP_RETURN_OUTPUT_SIZE - OP_RETURN_MAGIC_WORD_LENGTH  // 76
// Taproot-envelope payload ceiling, per-encoding by design:
// only encoding:"TAPROOT" gets it, every legacy lane keeps the 8,192-byte
// compiled ceiling (a global raise would multiply the chunk-lane abuse ceiling
// ~50x for no benefit). Measures the reassembled envelope payload byte length
// after concatenation of the payload pushes, which is byte-identical to the
// compiled action stream (finalDataBuffer) the shipped lanes carry; the
// envelope's own 520-byte push framing is NOT counted.
// DERIVED FROM WEIGHT: the binding limit is Bitcoin Core's
// MAX_STANDARD_TX_WEIGHT of 400,000 WU, not a round byte count. 400,000 payload
// bytes build a 402,789 WU reveal, which is non-standard and unrelayable; the
// true maxima are 397,228 (P2WPKH change) and 397,009 (P2TR change + floor pad).
// 390,000 sits 7,050 WU under the limit in the worst reveal shape. Re-derive it
// from the weight limit if it ever changes; do not pick a number.
const ENVELOPE_MAX_PAYLOAD = 390_000

// Bitcoin Core MAX_STANDARD_TX_WEIGHT, the policy limit ENVELOPE_MAX_PAYLOAD is
// derived from. Vendored so the derivation is testable here rather than being
// arithmetic in a comment. Canonical: xchain-documentation/protocol/constants.js.
const MAX_STANDARD_TX_WEIGHT = 400_000
// FILE payload compression. Vendored byte-identical from
// xchain-documentation/protocol/constants.js; the conformance suite keeps the
// copies in lockstep.
//
// COMPRESSION is a trailing optional field on FILE v0, empty/absent = raw and
// '1' = deflate-raw. It is PRESENTATIONAL, never consensus: FILE
// validity never inspects rawData content, so no reader may validate it.
const COMPRESSION_CODE_DEFLATE_RAW = '1'
// Serve-side ratio cap, mirrored here at EMIT time: a payload that
// compresses beyond it is emitted RAW, because a compliant reader would refuse
// to inflate it. 150:1 sits well under deflate-raw's ~1032:1 maximum.
const COMPRESSION_MAX_RATIO = 150
// Pre-compression input cap on rawData. The encoder is a hard single-instance
// service (it holds an exclusive lockfile), so compression is async and bounded.
const COMPRESSION_MAX_INPUT_BYTES = 16 * 1024 * 1024
const MAX_UTXO_COUNT = 500
const MAX_CUSTOM_OUTPUTS = 100
// Sanity ceiling on the fee/dust/feeQuote money fields: 21,000 BTC in satoshis.
// This is deliberately far tighter than the 21M-BTC supply, and the value is the
// contract, not a rounding of it. Do NOT "repair" it to 2_100_000_000_000_000 to
// chase a supply figure: that loosens every fee-path ceiling 1000x. Large output
// amounts do not route here; they go through parseSatoshiAmount's u64 ceiling.
const MAX_FEE_SATOSHIS = 2_100_000_000_000
// Maximum accepted raw-transaction hex length, in characters. A standard
// BTC/LTC/DOGE transaction tops out around 100 KB (200,000 hex chars), so
// 400,000 chars (a 200 KB transaction) is comfortably above anything the
// platform constructs while still shedding megabyte garbage before it reaches
// Transaction.fromHex / Buffer.from or a coin-node round-trip. The Express
// 1 MB body limit is the outer bound either way; this gives a precise, named
// rejection instead of a node-side parse error.
const MAX_RAW_TX_HEX_LENGTH = 400_000
// broadcast_tx ceiling, wider than MAX_RAW_TX_HEX_LENGTH on purpose: a signed
// Taproot-envelope reveal carries up to ENVELOPE_MAX_PAYLOAD payload bytes in
// its witness, so the whole transaction runs to ~405 KB (~810,000 hex chars),
// which the old 400,000-char cap would refuse at the last step of the flow.
// 1,000,000 chars (a 500 KB transaction) clears the largest legal reveal with
// headroom while still shedding megabyte garbage. p2shHex deliberately keeps
// the tighter cap: chunk-lane funding transactions never approach it.
const MAX_BROADCAST_TX_HEX_LENGTH = 1_000_000
const RAW_TX_HEX_RE = /^(?:[0-9a-fA-F]{2})+$/
// Maximum accepted utxos[].scriptPubKey hex length, in characters. Bitcoin's
// consensus MAX_SCRIPT_SIZE is 10,000 bytes, so 20,000 hex chars is the widest
// a legitimate output script can be; anything larger is garbage and is rejected
// before it reaches Buffer.from(...,'hex') / bitcoin.script.decompile.
const MAX_SCRIPTPUBKEY_HEX_LENGTH = 20_000
// AUTO is not a carrier: it is the caller's explicit request that the encoder
// pick the smallest-footprint carrier the network and signer support. It
// resolves to one of the others before anything is built. It is an
// OPT-IN precisely because resolving to TAPROOT changes the response shape from
// one PSBT to a commit/reveal pair, which no existing caller expects.
const VALID_ENCODINGS = new Set(['OP_RETURN', 'P2SH', 'MULTISIGN', 'P2WSH', 'TAPROOT', 'AUTO'])
const HEX_64_RE = /^[0-9a-fA-F]{64}$/
const COMPRESSED_PUBKEY_RE = /^(02|03)[0-9a-fA-F]{64}$/

// Canonical ACTION names the decoder accepts (xchain-decoder VALID_ACTION_NAMES,
// XChainDecoder.js). Vendored here byte-for-byte from
// xchain-documentation/protocol/action-manifest.json (wireDecoded slice), the
// same source xchain-decoder/test/fixtures/action-manifest.json vendors from.
// The decoder is the arbiter of which leading ACTION token survives
// decode (both the confirmed-block and mempool gates reject anything not in
// this set, after alias expansion, silently no-actioning the tx); the encoder
// had no equivalent gate, so a typoed or too-new ACTION name would encode, pay
// fees, and broadcast, then vanish silently at decode. Pinned against drift by
// test/unit/ActionManifestConformance.test.js, mirroring the decoder's own
// conformance guard.
const VALID_ACTION_NAMES = new Set([
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST',
    'BATCH', 'BET', 'BROADCAST', 'CALLBACK', 'COINPAY', 'COLLECT',
    'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'NODEPROOF', 'ORDER', 'PRICE', 'SEND', 'SLASH', 'SLEEP', 'STAKE', 'SWAP',
    'SWEEP', 'UNSTAKE', 'VOTE', 'WITHDRAW'
])

// Short-form ACTION-name aliases, expanded to canonical form before the
// VALID_ACTION_NAMES gate. Must stay identical to xchain-decoder's
// ACTION_ALIASES (XChainDecoder.js): the decoder is what actually expands
// these on-chain, so the encoder's pre-check has to agree with it exactly or
// it will reject an alias the decoder would have accepted, or (worse) accept a
// typo the decoder does not recognize as an alias.
const ACTION_ALIASES = {
    'TRANSFER': 'SEND',
    'ADDR': 'ADDRESS',
    'DROP': 'AIRDROP',
    'CAST': 'BROADCAST',
    'MSG': 'MESSAGE'
}

// Exact-integer parse for satoshi/fee money fields. Unlike parseInt, this
// rejects decimals, scientific notation, hex, and trailing garbage ("1e8" ->
// 1, "100.5" -> 100, "5abc" -> 5, "0x20" -> 0) instead of silently truncating
// to a wrong value on the money path. Returns the exact integer, or NaN if
// `raw` is not an exact integer representation. Sign and range bounds are left
// to the caller so each validator keeps its own error type and message.
function toExactInt(raw) {
    if (typeof raw === 'number') {
        return Number.isInteger(raw) ? raw : NaN
    }
    if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
        return Number(raw.trim())
    }
    return NaN
}

// Strict optional-boolean validator for policy flags (rbf, unconfirmed).
// undefined/null pass through as undefined so downstream defaults apply; a
// provided value must be a real boolean. TypeError so api.js maps it to
// -32602 invalid-params, like the money/hex validators.
function validateOptionalBoolean(raw, label) {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'boolean') {
        throw new TypeError(`${label} must be a boolean (got ${typeof raw}${typeof raw === 'string' ? ` "${raw}"` : ''}); string "false" would coerce to true`)
    }
    return raw
}

// Wire-format ceiling for a satoshi amount: the transaction output value
// field is an unsigned 64-bit integer, so 2^64-1 is the largest amount any
// coin can carry in one output regardless of supply policy.
const MAX_SATOSHI_U64 = 0xffffffffffffffffn

// Parse a satoshi amount, rejecting any value that cannot be represented
// exactly. The utxo-tracker emits full-precision decimal strings
// (readBigUInt64BE().toString()), so a 64-bit value reaches the encoder
// intact; a JS Number above Number.MAX_SAFE_INTEGER (2^53-1 ~= 9.007e15
// sats) cannot hold it exactly. For BTC/LTC this is unreachable (21M cap =
// 2.1e15 sats), but DOGE has no supply cap, so a single output can exceed
// it (>~90.07M DOGE). Fields that may legitimately carry such amounts
// (utxos[].value, customOutputs[].value) opt in with {allowBig: true}: an
// exact decimal STRING above 2^53-1 then parses to a BigInt (up to the u64
// wire ceiling); a Number above 2^53-1 is still rejected because it was
// already rounded before it reached us (JSON.parse or caller arithmetic).
// Without allowBig the original fail-closed behavior is unchanged.
function parseSatoshiAmount(raw, label, opts) {
    const allowBig = !!(opts && opts.allowBig)
    // Already-coerced BigInt (validateUtxoEntry/validateCustomOutput ran
    // first; createTransaction re-parses defensively): re-validate in place.
    if (typeof raw === 'bigint') {
        if (raw < 0n) {
            throw new RangeError(`${label} must be a non-negative integer`)
        }
        if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) {
            return Number(raw)
        }
        if (!allowBig) {
            throw new RangeError(`${label} (${raw}) exceeds the maximum safe satoshi amount (${Number.MAX_SAFE_INTEGER}) and cannot be represented without precision loss`)
        }
        if (raw > MAX_SATOSHI_U64) {
            throw new RangeError(`${label} (${raw}) exceeds the maximum 64-bit satoshi amount (${MAX_SATOSHI_U64})`)
        }
        return raw
    }
    const num = toExactInt(raw)
    if (isNaN(num) || num < 0) {
        throw new RangeError(`${label} must be a non-negative integer`)
    }
    if (Number.isSafeInteger(num)) {
        return num
    }
    if (allowBig && typeof raw === 'string') {
        // toExactInt already guaranteed /^-?\d+$/ and the num<0 check above
        // guaranteed non-negative, so this BigInt parse cannot throw.
        const big = BigInt(raw.trim())
        if (big > MAX_SATOSHI_U64) {
            throw new RangeError(`${label} (${raw.trim()}) exceeds the maximum 64-bit satoshi amount (${MAX_SATOSHI_U64})`)
        }
        return big
    }
    throw new RangeError(`${label} (${typeof raw === 'string' ? raw : num}) exceeds the maximum safe satoshi amount (${Number.MAX_SAFE_INTEGER}) and cannot be represented without precision loss${allowBig ? '; pass amounts above it as an exact decimal string' : ''}`)
}

// params.pubkey is not a real pubkey: it is the caller's base58 sender
// address (fed straight to utxoTrackerConnector.getUtxosFromAddress and to
// bitcoin.address.fromBase58Check in XChainEncoder.js). It must be held to
// the same shared bound as every other address-shaped field, so this
// delegates to validateAddress (defined below) rather than keeping its own
// private, looser cap. Only the null-passthrough semantics differ from
// validateAddress, since pubkey is validated for presence separately in
// validateAll.
function validatePubkey(pubkey) {
    if (pubkey == null) return null
    return validateAddress(pubkey, 'pubkey')
}

// Index of the first code unit a latin-1 byte cannot hold, or -1. Written as a scan
// rather than a regex so the source carries no literal high or control characters.
function firstNonLatin1(str) {
    for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) > 0xFF) return i
    return -1
}

// Gate `data` and `rawData` on what their wire encodings can actually carry, not
// just on being strings. prepareData converts data with Buffer.from(data,'utf8')
// and rawData with Buffer.from(rawData,'binary') (XChainEncoder.js), and neither
// conversion is reversible for every JS string: an unpaired surrogate becomes
// U+FFFD under utf8, and a code unit above U+00FF is truncated to its low byte
// under latin-1. Accepting those silently mutates a fee-paid payload into bytes
// the decoder can never reconstruct into the value that was validated, so refuse
// them here instead. RangeError so api.js maps it to -32602 invalid-params. Only
// non-roundtrippable inputs are newly rejected, so nothing that used to encode
// faithfully regresses.
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
// themselves (envelopePushSize below).
function compiledPushSize(byteLength) {
    if (byteLength <= 75)  return byteLength + 1   // direct push opcode
    if (byteLength <= 255) return byteLength + 2   // OP_PUSHDATA1
    return byteLength + 3                           // OP_PUSHDATA2
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
function validateActionName(data) {
    if (data == null || data.length === 0) return
    const rawActionName = data.split('|')[0]
    const actionName = ACTION_ALIASES[rawActionName] ?? rawActionName
    if (!VALID_ACTION_NAMES.has(actionName)) {
        throw new RangeError(
            `data has unknown ACTION name '${rawActionName.slice(0, 32)}'; ` +
            'the decoder rejects any leading token that is not a canonical action ' +
            'name or alias, silently dropping the ACTION on a fee-paid transaction')
    }
}

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
    // the legacy ceiling, because the legacy lanes' decoders silently drop
    // anything over 8,192 compiled bytes.
    //
    // AUTO is here because selectEncoding (XChainEncoder.js) resolves an AUTO
    // request to TAPROOT once the payload outgrows OP_RETURN and the caller
    // affirms signerSupportsTapscript with a compressedPubKey. This validator is
    // network-agnostic (it cannot see network.supportsSegwit) and runs before
    // that resolution, so it can only apply the WIDEST ceiling any AUTO
    // resolution could legitimately use, and let _buildTransaction re-check the
    // resolved lane. Consequence: an AUTO request that resolves to a legacy lane
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

// The create_tx options bag. Unknown keys are refused rather than ignored: a
// misspelled capability that silently means "no" would send an envelope-capable
// signer down the P2WSH lane at 2x the cost with no signal, and a misspelled one
// that silently meant "yes" would be worse.
const VALID_CREATE_TX_OPTIONS = new Set(['signerSupportsTapscript'])
function validateCreateTxOptions(options) {
    if (options == null) return null
    if (typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('options must be an object')
    }
    for (const key of Object.keys(options)) {
        if (!VALID_CREATE_TX_OPTIONS.has(key)) {
            throw new TypeError(`Unknown options key: "${key}". Valid keys: ${[...VALID_CREATE_TX_OPTIONS].join(', ')}`)
        }
    }
    if (options.signerSupportsTapscript !== undefined) {
        validateOptionalBoolean(options.signerSupportsTapscript, 'options.signerSupportsTapscript')
    }
    return options
}

function validateFee(fee) {
    if (fee == null || fee === false) return null
    const num = toExactInt(fee)
    if (isNaN(num)) {
        throw new TypeError(`fee must be a valid integer, got: ${typeof fee === 'string' ? fee : typeof fee}`)
    }
    if (num < 0) {
        throw new RangeError('fee must be non-negative')
    }
    if (num > MAX_FEE_SATOSHIS) {
        throw new RangeError(`fee (${num}) exceeds maximum (${MAX_FEE_SATOSHIS})`)
    }
    return num
}

function validateFeePerKb(feePerKb) {
    if (feePerKb == null || feePerKb === false) return null
    // Reject types a bare Number() would silently coerce to a plausible rate:
    // boolean (true -> 1), array ([50] -> 50), object (-> NaN but still a wrong
    // type on a money field). Only a real number or a numeric string is valid.
    if (typeof feePerKb !== 'number' && typeof feePerKb !== 'string') {
        throw new TypeError('feePerKb must be a finite number')
    }
    let num
    if (typeof feePerKb === 'number') {
        num = feePerKb
    } else {
        // String path: allow only a plain decimal (optionally fractional). This
        // rejects hex ('0x20' -> 32), scientific ('1e3' -> 1000), Infinity/NaN
        // spellings, and any trailing garbage that Number() would otherwise
        // accept, while still permitting a legitimately fractional feePerKb.
        const s = feePerKb.trim()
        if (!/^-?\d+(\.\d+)?$/.test(s)) {
            throw new TypeError('feePerKb must be a finite number')
        }
        num = Number(s)
    }
    if (isNaN(num) || !isFinite(num)) {
        throw new TypeError('feePerKb must be a finite number')
    }
    if (num <= 0) {
        throw new RangeError('feePerKb must be positive')
    }
    return num
}

function validateDust(dust) {
    if (dust == null || dust === false) return null
    const num = toExactInt(dust)
    if (isNaN(num)) {
        throw new TypeError('dust must be a valid integer')
    }
    if (num < 0) {
        throw new RangeError('dust must be non-negative')
    }
    if (num > MAX_FEE_SATOSHIS) {
        throw new RangeError(`dust (${num}) exceeds maximum (${MAX_FEE_SATOSHIS})`)
    }
    return num
}

function validateUtxoEntry(entry, index) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new TypeError(`utxos[${index}] must be an object`)
    }
    if (typeof entry.txid !== 'string' || !HEX_64_RE.test(entry.txid)) {
        throw new TypeError(`utxos[${index}].txid must be a 64-character hex string`)
    }
    // Route vout through toExactInt (rejecting NaN), not bare Number(): on the
    // money path a JSON null/''/false/[] all coerce via Number() to a plausible
    // index (0), so the encoder would build a PSBT spending txid:0, a different
    // outpoint than intended. Same exact-integer rigor the value field uses
    // (uuid:4555d78c).
    const vout = toExactInt(entry.vout)
    if (!Number.isInteger(vout) || vout < 0) {
        throw new TypeError(`utxos[${index}].vout must be a non-negative integer`)
    }
    entry.vout = vout

    // allowBig: a DOGE consolidation UTXO can legitimately exceed 2^53-1 sats;
    // the tracker emits it as an exact decimal string and the encoder's money
    // path carries it as a BigInt.
    entry.value = parseSatoshiAmount(entry.value, `utxos[${index}].value`, { allowBig: true })

    if (typeof entry.scriptPubKey !== 'string' || entry.scriptPubKey.length === 0) {
        throw new TypeError(`utxos[${index}].scriptPubKey must be a non-empty string`)
    }
    // scriptPubKey flows unchecked into Buffer.from(...,'hex') for the PSBT
    // witnessUtxo.script and into bitcoin.script.decompile in isSegwitUTXO.
    // Buffer.from(x,'hex') is lenient: it stops at the first invalid character
    // and drops a trailing odd nibble, so a malformed value ('zz', odd length)
    // silently yields a truncated script and misclassifies the input. Anchor it
    // to even-length hex with a sane bound, matching the txid/rawTxHex rigor.
    if (entry.scriptPubKey.length > MAX_SCRIPTPUBKEY_HEX_LENGTH) {
        throw new RangeError(`utxos[${index}].scriptPubKey exceeds maximum length (${MAX_SCRIPTPUBKEY_HEX_LENGTH})`)
    }
    if (!RAW_TX_HEX_RE.test(entry.scriptPubKey)) {
        throw new TypeError(`utxos[${index}].scriptPubKey must be an even-length hex string`)
    }
    if (entry.confirmations == null) {
        entry.confirmations = 0
    } else {
        // Validate like vout: the unconfirmed-UTXO filter in XChainEncoder
        // compares `confirmations == 0` with loose equality, so an untyped
        // value (string, float, object) could let a mempool input slip past
        // the exclusion when unconfirmed=false. Coerce to a real number and
        // range-check so the downstream comparison always sees an integer.
        const confirmations = toExactInt(entry.confirmations)
        if (!Number.isInteger(confirmations) || confirmations < 0) {
            throw new TypeError(`utxos[${index}].confirmations must be a non-negative integer`)
        }
        entry.confirmations = confirmations
    }
    return entry
}

function validateUtxoArray(utxos) {
    if (utxos == null) return null
    if (!Array.isArray(utxos)) {
        throw new TypeError('utxos must be an array')
    }
    if (utxos.length > MAX_UTXO_COUNT) {
        throw new RangeError(`utxos array length (${utxos.length}) exceeds maximum (${MAX_UTXO_COUNT})`)
    }
    for (let i = 0; i < utxos.length; i++) {
        validateUtxoEntry(utxos[i], i)
    }
    return utxos
}

function validateCustomOutput(output, index) {
    if (typeof output !== 'object' || output === null || Array.isArray(output)) {
        throw new TypeError(`customOutputs[${index}] must be an object`)
    }
    validateAddress(output.address, `customOutputs[${index}].address`)
    // allowBig: a >2^53-1-sat DOGE payment output is legitimate; it must be
    // supplied as an exact decimal string.
    output.value = parseSatoshiAmount(output.value, `customOutputs[${index}].value`, { allowBig: true })
    // A caller-supplied output of 0 sats is consensus-valid but relay-rejected
    // as an unspendable/dust output, so the caller signs a PSBT that can never
    // broadcast. Reject it at the trust boundary, matching validateFeeQuote's
    // positive-amount contract. Interim safe rule: reject only value <= 0 (not a
    // full per-network dust floor). The native-fee FEE_DESTINATION output is
    // injected into customOutputs AFTER validateCustomOutputs runs (see
    // XChainEncoder.createTransaction), so it never passes through here and its
    // sub-dust-but-positive DOGE fee values keep working.
    if (output.value <= 0) {
        throw new RangeError(`customOutputs[${index}].value must be a positive integer (satoshis)`)
    }
    return output
}

function validateCustomOutputs(customOutputs) {
    if (customOutputs == null) return null
    if (!Array.isArray(customOutputs)) {
        throw new TypeError('customOutputs must be an array')
    }
    if (customOutputs.length > MAX_CUSTOM_OUTPUTS) {
        throw new RangeError(`customOutputs length (${customOutputs.length}) exceeds maximum (${MAX_CUSTOM_OUTPUTS})`)
    }
    for (let i = 0; i < customOutputs.length; i++) {
        validateCustomOutput(customOutputs[i], i)
    }
    return customOutputs
}

function validateFeeQuote(feeQuote) {
    if (feeQuote == null) return null
    if (typeof feeQuote !== 'object') {
        throw new TypeError('feeQuote must be an object with address and amount')
    }
    validateAddress(feeQuote.address, 'feeQuote.address')
    const amount = toExactInt(feeQuote.amount)
    if (isNaN(amount) || amount <= 0) {
        throw new RangeError('feeQuote.amount must be a positive integer (satoshis)')
    }
    if (amount > MAX_FEE_SATOSHIS) {
        throw new RangeError('feeQuote.amount exceeds maximum (' + MAX_FEE_SATOSHIS + ')')
    }
    feeQuote.amount = amount
    return feeQuote
}

function validateP2shParams(p2shHash, p2shHex) {
    const hasHash = (p2shHash != null && p2shHash !== false)
    const hasHex = (p2shHex != null && p2shHex !== false)

    if (!hasHash && !hasHex) return { p2shHash: null, p2shHex: null }
    if (hasHash !== hasHex) {
        throw new TypeError('p2shHash and p2shHex must both be provided or both omitted')
    }
    if (typeof p2shHash !== 'string' || !HEX_64_RE.test(p2shHash)) {
        throw new TypeError('p2shHash must be a 64-character hex string')
    }
    if (typeof p2shHex !== 'string' || p2shHex.length === 0) {
        throw new TypeError('p2shHex must be a non-empty hex string')
    }
    if (p2shHex.length > MAX_RAW_TX_HEX_LENGTH) {
        throw new TypeError('p2shHex exceeds maximum length (' + MAX_RAW_TX_HEX_LENGTH + ')')
    }
    if (!RAW_TX_HEX_RE.test(p2shHex)) {
        throw new TypeError('p2shHex must be an even-length hex string')
    }
    return { p2shHash, p2shHex }
}

// Raw signed-transaction hex for broadcast_tx. The node would reject malformed
// hex anyway; rejecting here sheds obvious garbage before the round-trip and
// returns a -32602 with a precise reason instead of a node parse error.
function validateRawTxHex(txHex) {
    if (typeof txHex !== 'string' || txHex.length === 0) {
        throw new TypeError('tx_hex must be a non-empty hex string')
    }
    if (txHex.length > MAX_BROADCAST_TX_HEX_LENGTH) {
        throw new TypeError('tx_hex exceeds maximum length (' + MAX_BROADCAST_TX_HEX_LENGTH + ')')
    }
    if (!RAW_TX_HEX_RE.test(txHex)) {
        throw new TypeError('tx_hex must be an even-length hex string')
    }
    return txHex
}

function validateCompressedPubKey(compressedPubKey) {
    if (compressedPubKey == null) return null
    if (typeof compressedPubKey !== 'string' || !COMPRESSED_PUBKEY_RE.test(compressedPubKey)) {
        throw new TypeError('compressedPubKey must be a 66-character hex string starting with 02 or 03')
    }
    return compressedPubKey
}

// Shape-only address check (non-empty string, capped at 100 chars). Shared
// core for every address-shaped field: the get_utxos address param,
// validateChange, validatePubkey (params.pubkey is actually a sender
// address, not a real pubkey), and customOutputs[].address / feeQuote.address.
// Coin-specific base58/bech32 validity is left to bitcoinjs downstream; this
// just sheds obvious garbage (non-strings, empty, oversized) with a
// -32602-mappable TypeError. `label` names the field in the thrown message;
// callers that omit it keep the plain "address ..." wording.
function validateAddress(address, label = 'address') {
    if (typeof address !== 'string' || address.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`)
    }
    if (address.length > 100) {
        throw new TypeError(`${label} exceeds maximum length (100)`)
    }
    return address
}

function validateChange(change) {
    if (change == null) return null
    return validateAddress(change)
}

function validateAll(params) {
    if (typeof params !== 'object' || params === null) {
        throw new TypeError('Request params must be an object')
    }

    const data = validateDataParam(params.data, 'data')
    const rawData = validateDataParam(params.rawData, 'rawData')
    // Resolve encoding before the length check so validateCombinedDataLength can
    // apply the per-encoding (OP_RETURN) ceiling pre-compile.
    const encoding = validateEncoding(params.encoding)
    if (data != null || rawData != null) {
        validateCombinedDataLength(data, rawData, encoding)
        validateActionPushDecodability(data, rawData)
        validateActionName(data)
    }

    const pubkey = validatePubkey(params.pubkey)
    const fee = validateFee(params.fee)
    const feePerKb = validateFeePerKb(params.feePerKb)
    const dust = validateDust(params.dust)
    const utxos = validateUtxoArray(params.utxos)
    const customOutputs = validateCustomOutputs(params.customOutputs)
    const feeQuote = validateFeeQuote(params.feeQuote)
    const { p2shHash, p2shHex } = validateP2shParams(params.p2shHash, params.p2shHex)
    const compressedPubKey = validateCompressedPubKey(params.compressedPubKey)
    const change = validateChange(params.change)

    // MULTISIGN packs the caller's real pubkey as the 3rd fake-multisig pubkey, so it is
    // required. Without it the encoder reaches `Buffer.from(compressedPubKey, 'hex')` with
    // null and throws an opaque deep error; reject up front with a precise reason instead.
    if (encoding === 'MULTISIGN' && compressedPubKey == null) {
        throw new TypeError('compressedPubKey is required for MULTISIGN encoding')
    }

    // The Taproot-envelope leaf ends with <internal x-only pubkey> OP_CHECKSIG
    // and the commit's key-path cancel needs the same key, so the caller's real
    // pubkey is required (pubkey may be a bare address). Mirrors MULTISIGN.
    if (encoding === 'TAPROOT' && compressedPubKey == null) {
        throw new TypeError('compressedPubKey is required for TAPROOT encoding (it becomes the envelope internal key)')
    }

    // TAPROOT is a single-call flow: create_tx returns the {commit, reveal}
    // PSBT pair together, pre-built against the unsigned
    // commit's stable txid. The p2shHash/p2shHex second-call reveal flow is a
    // chunk-lane concept and must not engage here.
    if (encoding === 'TAPROOT' && p2shHash != null) {
        throw new TypeError('TAPROOT encoding does not use the p2shHash reveal flow; one create_tx call returns the commit and reveal PSBTs together')
    }

    // docs/openrpc.json marks pubkey required:true. validateAll never enforced
    // presence, so an omitted/null pubkey reached bitcoin.address.fromBase58Check(null)
    // deep in createTransaction and leaked a library "Expected String" as a -32603
    // internal error. Reject up front (RangeError, so api.js maps it to -32602
    // invalid-params) mirroring the MULTISIGN/compressedPubKey presence check above.
    if (pubkey == null) {
        throw new RangeError('pubkey is required')
    }

    // rbf and unconfirmed must be real JSON booleans when explicitly provided.
    // Truthiness coercion here was a policy flip on a money path: Boolean("false")
    // is true, so a stringy-boolean client asking to EXCLUDE mempool coins would
    // silently have them selected (and rbf "false" would arm replace-by-fee).
    // Absent/null params stay undefined (NOT false) and inherit createTransaction's
    // defaults downstream: unconfirmed defaults to true (unconfirmed UTXOs are
    // selectable), rbf defaults to falsy. Do not "fix" the code to force false
    // here, that would silently flip the UTXO-selection policy on a money path.
    const rbf = validateOptionalBoolean(params.rbf, 'rbf')
    const unconfirmed = validateOptionalBoolean(params.unconfirmed, 'unconfirmed')

    // Attach each segwit input's FULL previous transaction alongside
    // its witnessUtxo. Off by default because it costs one node round trip per
    // input plus the prev tx's bytes in every copy of the PSBT, and only a
    // hardware signer needs it: Ledger derives the outpoint it signs from the
    // prev tx it is handed, so a witnessUtxo-only input cannot be signed on a
    // device at all (it used to be signed against a SYNTHESIZED prev tx, which
    // produced a valid-looking signature over an outpoint that does not exist).
    const attachPrevTx = validateOptionalBoolean(params.attachPrevTx, 'attachPrevTx')

    // Transparent FILE payload compression. TRI-STATE: absent means "use the
    // deployment default" (currently ON), and an explicit true/false is the
    // caller's own choice. An explicit true that
    // cannot be honoured is an error; the default pass just rides raw.
    const compress = validateOptionalBoolean(params.compress, 'compress')

    // Signer capability for AUTO selection. Absent means "cannot sign a
    // tapscript spend", the fail-closed direction: the reveal must be signable
    // before the commit is broadcast, so an unaffirmed signer never gets the
    // envelope. Kept in an options bag rather than as another positional
    // parameter, so the next capability does not grow the signature again.
    const options = validateCreateTxOptions(params.options)

    return {
        utxos, pubkey, customOutputs, data, rawData, fee, rbf,
        encoding, change, p2shHash, p2shHex, compressedPubKey,
        unconfirmed, feePerKb, dust, feeQuote, attachPrevTx, compress, options
    }
}

module.exports = {
    validatePubkey,
    validateDataParam,
    validateCombinedDataLength,
    isMinimalOpSingleByte,
    validateActionPushDecodability,
    validateActionName,
    VALID_ACTION_NAMES,
    ACTION_ALIASES,
    // Exported for the decoder's compiledPushSizeConformance test, which pins
    // this formula against the decoder's identical arbiter-side helper.
    compiledPushSize,
    validateEncoding,
    validateFee,
    validateFeePerKb,
    validateOptionalBoolean,
    validateDust,
    validateUtxoArray,
    validateUtxoEntry,
    validateCustomOutputs,
    validateP2shParams,
    validateRawTxHex,
    validateCompressedPubKey,
    validateChange,
    validateAddress,
    validateAll,
    parseSatoshiAmount,
    MAX_SATOSHI_U64,
    MAX_RAW_TX_HEX_LENGTH,
    MAX_BROADCAST_TX_HEX_LENGTH,
    ENVELOPE_MAX_PAYLOAD,
    MAX_STANDARD_TX_WEIGHT,
    COMPRESSION_CODE_DEFLATE_RAW,
    COMPRESSION_MAX_RATIO,
    COMPRESSION_MAX_INPUT_BYTES,
    MAX_DATA_BYTES,
    MAX_COMPILED_ACTION_DATA_LENGTH,
    MAX_UTXO_COUNT,
    MAX_CUSTOM_OUTPUTS,
    MAX_FEE_SATOSHIS,
    MAX_SCRIPTPUBKEY_HEX_LENGTH,
    VALID_ENCODINGS
}
