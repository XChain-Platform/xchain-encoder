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
    VALID_CREATE_TX_OPTIONS,
    MAX_FEE_SATOSHIS,
    RAW_TX_HEX_RE,
    MAX_SCRIPTPUBKEY_HEX_LENGTH,
    HEX_64_RE,
    MAX_UTXO_COUNT,
    MAX_CUSTOM_OUTPUTS
} = require('./constants')
const {
    validateOptionalBoolean,
    toExactInt,
    parseSatoshiAmount
} = require('./value_checks')
const validateAddress = (...args) => require('./transaction_checks').validateAddress(...args)

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
    // Strict boolean for the same reason rbf is: exactInputs turns UTXO selection
    // off, and the string "false" is truthy, so a loose check would spend every
    // outpoint in the caller's set when they asked for the opposite.
    if (options.exactInputs !== undefined) {
        validateOptionalBoolean(options.exactInputs, 'options.exactInputs')
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

function validateUtxoOutpoint(entry, index) {
    // Reject anything that is not a plain object: a string, number, array or
    // null here means the caller sent the wrong shape, not a bad field, so
    // each UTXO must arrive as its own {txid, vout, value, scriptPubKey} record.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new TypeError(`utxos[${index}] must be an object`)
    }
    // The outpoint's transaction id must be exactly 32 bytes of hex (64 chars);
    // anything shorter, longer or non-hex cannot name a real transaction.
    if (typeof entry.txid !== 'string' || !HEX_64_RE.test(entry.txid)) {
        throw new TypeError(`utxos[${index}].txid must be a 64-character hex string`)
    }
    // Canonicalize case, because on the OP_RETURN/MULTISIGN path this string IS the
    // AES-128-CTR obfuscation key (XChainEncoder.obfuscate splits it with substr), and
    // the decoder derives its key from the wire bytes, which render as lowercase hex.
    // 'A' (0x41) and 'a' (0x61) are different key bytes, so an accepted mixed-case txid
    // could never round-trip; the ins[0] guard then rejected the build as a bogus
    // INPUT_SELECTION_RACE. Normalizing here also makes the reservation keys and the
    // duplicate filter below compare one form of each outpoint. Mutating in place is
    // this function's established contract (vout, value and confirmations already are).
    entry.txid = entry.txid.toLowerCase()
    // Route vout through toExactInt (rejecting NaN), not bare Number(): on the
    // money path a JSON null/''/false/[] all coerce via Number() to a plausible
    // index (0), so the encoder would build a PSBT spending txid:0, a different
    // outpoint than intended. This matches the value field's exact-integer rigor
    // and rejects values that Number() would silently coerce to zero.
    const vout = toExactInt(entry.vout)
    if (!Number.isInteger(vout) || vout < 0) {
        throw new TypeError(`utxos[${index}].vout must be a non-negative integer`)
    }
    entry.vout = vout
}

function validateUtxoValueAndScript(entry, index) {
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
}

function validateUtxoEntry(entry, index) {
    validateUtxoOutpoint(entry, index)
    validateUtxoValueAndScript(entry, index)
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
    // Array.isArray, because typeof [] is 'object': a JSON array cleared this gate
    // and died one line later on validateAddress(undefined), reporting an address
    // error for what is a shape error. Same guard the other object-shaped
    // validators carry (lines 481/557/635). No === null clause: the line above
    // already returns for a null/absent quote, which is legal.
    if (typeof feeQuote !== 'object' || Array.isArray(feeQuote)) {
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

module.exports = {
    validateCreateTxOptions,
    validateFee,
    validateFeePerKb,
    validateDust,
    validateUtxoEntry,
    validateUtxoArray,
    validateCustomOutput,
    validateCustomOutputs,
    validateFeeQuote
}
