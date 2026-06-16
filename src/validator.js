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

// Largest raw single-push payload that still fits the compiled on-chain ceiling:
// a raw payload of N bytes (N >= 256) compiles to N + 3 once the OP_PUSHDATA2
// prefix is added, so 8189 + 3 == 8192. Retained as the documented single-push
// limit; validateCombinedDataLength now derives the actual ceiling per push via
// compiledPushSize so that dual-push payloads are measured against the compiled
// ceiling directly rather than this single-push approximation.
const MAX_DATA_BYTES = 8189
// Maximum *compiled* on-chain ACTION push, in bytes. Must equal the decoder's
// MAX_ACTION_DATA_LENGTH — a transaction whose compiled push exceeds this is
// silently dropped by every indexing node. Canonical source of truth:
// xchain-documentation/protocol/constants.js (MAX_ACTION_DATA_LENGTH). The
// cross-service regression suite asserts these stay equal.
const MAX_COMPILED_ACTION_DATA_LENGTH = 8192
const MAX_UTXO_COUNT = 500
const MAX_CUSTOM_OUTPUTS = 100
const MAX_FEE_SATOSHIS = 2_100_000_000_000 // 21M BTC in satoshis
// Maximum accepted raw-transaction hex length, in characters. A standard
// BTC/LTC/DOGE transaction tops out around 100 KB (200,000 hex chars), so
// 400,000 chars (a 200 KB transaction) is comfortably above anything the
// platform constructs while still shedding megabyte garbage before it reaches
// Transaction.fromHex / Buffer.from or a coin-node round-trip. The Express
// 1 MB body limit is the outer bound either way; this gives a precise, named
// rejection instead of a node-side parse error.
const MAX_RAW_TX_HEX_LENGTH = 400_000
const RAW_TX_HEX_RE = /^(?:[0-9a-fA-F]{2})+$/
const VALID_ENCODINGS = new Set(['OP_RETURN', 'P2SH', 'MULTISIGN', 'P2WSH'])
const HEX_64_RE = /^[0-9a-fA-F]{64}$/
const COMPRESSED_PUBKEY_RE = /^(02|03)[0-9a-fA-F]{64}$/

function validatePubkey(pubkey) {
    if (pubkey == null) return null
    if (typeof pubkey !== 'string' || pubkey.length === 0) {
        throw new TypeError('pubkey must be a non-empty string')
    }
    if (pubkey.length > 200) {
        throw new TypeError('pubkey exceeds maximum length (200)')
    }
    return pubkey
}

function validateDataParam(value, fieldName) {
    if (value == null) return null
    if (typeof value !== 'string') {
        throw new TypeError(`${fieldName} must be a string`)
    }
    return value
}

// Size of a single script push once bitcoin.script.compile adds its length
// prefix: a direct push opcode for <=75 bytes, OP_PUSHDATA1 (+2) for <=255, or
// OP_PUSHDATA2 (+3) beyond that. Mirrors how prepareData compiles data/rawData.
function compiledPushSize(byteLength) {
    if (byteLength <= 75)  return byteLength + 1   // direct push opcode
    if (byteLength <= 255) return byteLength + 2   // OP_PUSHDATA1
    return byteLength + 3                           // OP_PUSHDATA2
}

function validateCombinedDataLength(data, rawData) {
    if (data == null) return
    const dataBytes = Buffer.byteLength(data, 'utf8')
    // Match XChainEncoder.js — rawData is bytes-as-string (Latin-1), so the
    // on-chain byte count is the string length, not the UTF-8 encoding length.
    const rawBytes = rawData != null ? Buffer.byteLength(rawData, 'binary') : 0
    // When both fields are present, prepareData compiles them as two separate
    // pushes (bitcoin.script.compile([utf8Buffer, rawDataBuffer])), so each push
    // carries its own length-prefix overhead. Summing the raw byte counts would
    // undercount the on-chain size and let dual-push payloads slip past this
    // pre-check only to fail the compiled-size ceiling later in createTransaction.
    const compiled = compiledPushSize(dataBytes) + (rawData != null ? compiledPushSize(rawBytes) : 0)
    if (compiled > MAX_COMPILED_ACTION_DATA_LENGTH) {
        throw new RangeError(`Combined compiled payload (${compiled} bytes) exceeds maximum (${MAX_COMPILED_ACTION_DATA_LENGTH})`)
    }
}

function validateEncoding(encoding) {
    if (encoding == null) return null
    if (typeof encoding !== 'string' || !VALID_ENCODINGS.has(encoding)) {
        throw new TypeError(`Invalid encoding: "${encoding}". Valid values: ${[...VALID_ENCODINGS].join(', ')}`)
    }
    return encoding
}

function validateFee(fee) {
    if (fee == null || fee === false) return null
    const num = parseInt(fee, 10)
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
    const num = Number(feePerKb)
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
    const num = parseInt(dust, 10)
    if (isNaN(num)) {
        throw new TypeError('dust must be a valid integer')
    }
    if (num < 0) {
        throw new RangeError('dust must be non-negative')
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
    const vout = Number(entry.vout)
    if (!Number.isInteger(vout) || vout < 0) {
        throw new TypeError(`utxos[${index}].vout must be a non-negative integer`)
    }
    entry.vout = vout

    const value = parseInt(entry.value, 10)
    if (isNaN(value) || value < 0) {
        throw new RangeError(`utxos[${index}].value must be a non-negative integer`)
    }
    entry.value = value

    if (typeof entry.scriptPubKey !== 'string' || entry.scriptPubKey.length === 0) {
        throw new TypeError(`utxos[${index}].scriptPubKey must be a non-empty string`)
    }
    if (entry.confirmations == null) {
        entry.confirmations = 0
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
    if (typeof output.address !== 'string' || output.address.length === 0) {
        throw new TypeError(`customOutputs[${index}].address must be a non-empty string`)
    }
    if (output.address.length > 100) {
        throw new TypeError(`customOutputs[${index}].address exceeds maximum length (100)`)
    }
    const value = parseInt(output.value, 10)
    if (isNaN(value) || value < 0) {
        throw new RangeError(`customOutputs[${index}].value must be a non-negative integer`)
    }
    output.value = value
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
    if (typeof feeQuote.address !== 'string' || feeQuote.address.length === 0) {
        throw new TypeError('feeQuote.address must be a non-empty string')
    }
    if (feeQuote.address.length > 100) {
        throw new TypeError('feeQuote.address exceeds maximum length (100)')
    }
    const amount = parseInt(feeQuote.amount, 10)
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
    if (txHex.length > MAX_RAW_TX_HEX_LENGTH) {
        throw new TypeError('tx_hex exceeds maximum length (' + MAX_RAW_TX_HEX_LENGTH + ')')
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

function validateChange(change) {
    if (change == null) return null
    if (typeof change !== 'string' || change.length === 0) {
        throw new TypeError('change must be a non-empty string')
    }
    if (change.length > 100) {
        throw new TypeError('change address exceeds maximum length (100)')
    }
    return change
}

function validateAll(params) {
    if (typeof params !== 'object' || params === null) {
        throw new TypeError('Request params must be an object')
    }

    const data = validateDataParam(params.data, 'data')
    const rawData = validateDataParam(params.rawData, 'rawData')
    if (data != null) {
        validateCombinedDataLength(data, rawData)
    }

    const pubkey = validatePubkey(params.pubkey)
    const encoding = validateEncoding(params.encoding)
    const fee = validateFee(params.fee)
    const feePerKb = validateFeePerKb(params.feePerKb)
    const dust = validateDust(params.dust)
    const utxos = validateUtxoArray(params.utxos)
    const customOutputs = validateCustomOutputs(params.customOutputs)
    const feeQuote = validateFeeQuote(params.feeQuote)
    const { p2shHash, p2shHex } = validateP2shParams(params.p2shHash, params.p2shHex)
    const compressedPubKey = validateCompressedPubKey(params.compressedPubKey)
    const change = validateChange(params.change)

    // Pass through rbf and unconfirmed without strict validation (booleans with loose coercion is existing behavior)
    const rbf = params.rbf
    const unconfirmed = params.unconfirmed

    return {
        utxos, pubkey, customOutputs, data, rawData, fee, rbf,
        encoding, change, p2shHash, p2shHex, compressedPubKey,
        unconfirmed, feePerKb, dust, feeQuote
    }
}

module.exports = {
    validatePubkey,
    validateDataParam,
    validateCombinedDataLength,
    validateEncoding,
    validateFee,
    validateFeePerKb,
    validateDust,
    validateUtxoArray,
    validateUtxoEntry,
    validateCustomOutputs,
    validateP2shParams,
    validateRawTxHex,
    validateCompressedPubKey,
    validateChange,
    validateAll,
    MAX_RAW_TX_HEX_LENGTH,
    MAX_DATA_BYTES,
    MAX_COMPILED_ACTION_DATA_LENGTH,
    MAX_UTXO_COUNT,
    MAX_CUSTOM_OUTPUTS,
    MAX_FEE_SATOSHIS,
    VALID_ENCODINGS
}
