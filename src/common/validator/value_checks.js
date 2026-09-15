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

const { MAX_SATOSHI_U64 } = require('./constants')
const validateAddress = (...args) => require('./transaction_checks').validateAddress(...args)

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

module.exports = {
    toExactInt,
    validateOptionalBoolean,
    parseSatoshiAmount,
    validatePubkey,
    firstNonLatin1
}
