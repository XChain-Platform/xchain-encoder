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
    MAX_RAW_TX_HEX_LENGTH,
    RAW_TX_HEX_RE,
    HEX_64_RE,
    MAX_BROADCAST_TX_HEX_LENGTH,
    COMPRESSED_PUBKEY_RE
} = require('./constants')
const {
    validateOptionalBoolean,
    validatePubkey
} = require('./value_checks')
const {
    validateDataParam,
    validateActionPushDecodability,
    validateActionName,
    validateCombinedDataLength,
    validateEncoding
} = require('./action_data_checks')
const {
    validateCreateTxOptions,
    validateFee,
    validateFeePerKb,
    validateDust,
    validateUtxoArray,
    validateCustomOutputs,
    validateFeeQuote
} = require('./fee_and_utxo_checks')

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

// Reservation-ticket id for release_inputs: exactly the 16 random bytes
// mintReservationTicket emits, lowercase hex. Shape-checked here so a
// non-string, an oversized blob or a wrong-length id is a precise -32602 rather
// than reaching the encoder, and so the id can never be used as an unbounded
// key into the ticket map.
function validateReservationId(reservationId) {
    if (typeof reservationId !== 'string' || !/^[0-9a-f]{32}$/.test(reservationId)) {
        throw new TypeError('reservationId must be a 32-character lowercase hex string, as returned in create_tx result.reservation.id')
    }
    return reservationId
}

function validateChange(change) {
    if (change == null) return null
    return validateAddress(change)
}


/**
 * Validate and coerce every createTransaction parameter in one pass.
 * @param {object} params - the raw JSON-RPC params object for create_tx.
 * @returns {object} the same fields, each coerced to its checked form
 *   (amounts to exact integers, hex strings to lowercase, etc).
 * @throws {TypeError} a field is missing, the wrong type, or the wrong shape.
 * @throws {RangeError} a field is the right type but outside its allowed bound.
 */
function validateAll(params) {
    // Array.isArray, because typeof [] is 'object': a JSON-RPC call with POSITIONAL
    // params cleared this gate and died 50 lines later on 'pubkey is required',
    // reporting a missing field for what is a shape error. Same guard the
    // object-shaped validators below carry (lines 484/566/644/686).
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
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
    // chunked reveal concept and must not engage here.
    if (encoding === 'TAPROOT' && p2shHash != null) {
        throw new TypeError('TAPROOT encoding does not use the p2shHash reveal flow; one create_tx call returns the commit and reveal PSBTs together')
    }

    // docs/openrpc.json marks pubkey required:true. A missing pubkey otherwise
    // reaches bitcoin.address.fromBase58Check(null) and leaks a library
    // "Expected String" as a -32603 internal error. Reject up front (RangeError,
    // so api.js maps it to -32602 invalid-params), matching the
    // MULTISIGN/compressedPubKey presence check above.
    if (pubkey == null) {
        throw new RangeError('pubkey is required')
    }

    // rbf and unconfirmed must be real JSON booleans when explicitly provided.
    // Truthiness coercion here is a policy flip on a money path: Boolean("false")
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
    // device at all. A synthesized prev tx produces a valid-looking signature
    // over an outpoint that does not exist.
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
    validateP2shParams,
    validateRawTxHex,
    validateCompressedPubKey,
    validateAddress,
    validateReservationId,
    validateChange,
    validateAll
}
