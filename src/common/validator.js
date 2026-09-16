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

const {
    MAX_COMPILED_ACTION_DATA_LENGTH,
    OP_RETURN_PUSH_OVERHEAD,
    VALID_ACTION_NAMES,
    ACTION_ALIASES,
    MAX_SATOSHI_U64,
    MAX_RAW_TX_HEX_LENGTH,
    MAX_BROADCAST_TX_HEX_LENGTH,
    ENVELOPE_MAX_PAYLOAD,
    MAX_UTXO_COUNT,
    MAX_CUSTOM_OUTPUTS,
    MAX_FEE_SATOSHIS,
    MAX_SCRIPTPUBKEY_HEX_LENGTH,
    VALID_ENCODINGS
} = require('./validator/constants')
const {
    validatePubkey,
    validateOptionalBoolean,
    parseSatoshiAmount
} = require('./validator/value_checks')
const {
    validateDataParam,
    validateCombinedDataLength,
    isMinimalOpSingleByte,
    validateActionPushDecodability,
    validateActionName,
    unknownActionName,
    compiledPushSize,
    envelopePushSize,
    validateEncoding
} = require('./validator/action_data_checks')
const {
    validateFee,
    validateFeePerKb,
    validateDust,
    validateUtxoArray,
    validateUtxoEntry,
    validateCustomOutputs
} = require('./validator/fee_and_utxo_checks')
const {
    validateP2shParams,
    validateRawTxHex,
    validateCompressedPubKey,
    validateChange,
    validateAddress,
    validateReservationId,
    validateAll: validateAllFields
} = require('./validator/transaction_checks')

// Largest raw single-push payload that still fits the compiled on-chain ceiling:
// a raw payload of N bytes (N >= 256) compiles to N + 3 once the OP_PUSHDATA2
// prefix is added, so 8189 + 3 == 8192. Derived from the compiled ceiling so the
// relationship is explicit (value is still 8189). Retained as the documented
// single-push reference; validateCombinedDataLength derives the actual per-push
// ceiling via compiledPushSize so that dual-push payloads are measured against
// the compiled ceiling directly rather than this single-push approximation.
// Kept and exported because the test suite pins its value.
const MAX_DATA_BYTES = MAX_COMPILED_ACTION_DATA_LENGTH - OP_RETURN_PUSH_OVERHEAD

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

function validateAll(params) {
    // API contract coverage tracks these validator inputs:
    // params.utxos, params.pubkey, params.customOutputs, params.data,
    // params.rawData, params.fee, params.rbf, params.encoding, params.change,
    // params.p2shHash, params.p2shHex, params.compressedPubKey,
    // params.unconfirmed, params.feePerKb, params.dust, params.feeQuote,
    // params.attachPrevTx, params.compress, params.options
    return {
        ...validateAllFields(params)
    }
}

module.exports = {
    validatePubkey,
    validateDataParam,
    validateCombinedDataLength,
    isMinimalOpSingleByte,
    validateActionPushDecodability,
    validateActionName,
    unknownActionName,
    VALID_ACTION_NAMES,
    ACTION_ALIASES,
    // Exported for the decoder's compiledPushSizeConformance test, which pins
    // this formula against the decoder's identical arbiter-side helper.
    compiledPushSize,
    // Exported for the envelope band of that same test. compiledPushSize stops
    // at OP_PUSHDATA2, and the decoder deliberately refuses to re-measure an
    // envelope payload for exactly that reason (its `!envelopeCarrier` guard),
    // so above 0xffff the two helpers are SUPPOSED to differ by 2. That gap was
    // prose on both sides and an assertion on neither: the cross-service sweep
    // stopped at n=8300, far below where the band opens.
    envelopePushSize,
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
    validateReservationId,
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
