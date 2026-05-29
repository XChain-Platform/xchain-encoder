/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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

const MAX_DATA_BYTES = 8192
const MAX_UTXO_COUNT = 500
const MAX_CUSTOM_OUTPUTS = 100
const MAX_FEE_SATOSHIS = 2_100_000_000_000 // 21M BTC in satoshis
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

function validateCombinedDataLength(data, rawData) {
    if (data == null) return
    let total = Buffer.byteLength(data, 'utf8')
    if (rawData != null) {
        // Match XChainEncoder.js — rawData is bytes-as-string (Latin-1), so the
        // on-chain byte count is the string length, not the UTF-8 encoding length.
        total += Buffer.byteLength(rawData, 'binary')
    }
    if (total > MAX_DATA_BYTES) {
        throw new RangeError(`Combined data payload (${total} bytes) exceeds maximum (${MAX_DATA_BYTES})`)
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
    return { p2shHash, p2shHex }
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
    validateCompressedPubKey,
    validateChange,
    validateAll,
    MAX_DATA_BYTES,
    MAX_UTXO_COUNT,
    MAX_CUSTOM_OUTPUTS,
    MAX_FEE_SATOSHIS,
    VALID_ENCODINGS
}
