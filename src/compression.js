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
 * Emit-side FILE payload compression.
 *
 * The encoder is the only service that COMPRESSES; it never inflates. That
 * asymmetry is deliberate: inflation is the attack surface (a hostile payload
 * can lie about its own compressibility), and the encoder never reads
 * third-party bytes back.
 *
 * Three rules govern this file:
 *
 *  1. ASYNC ONLY. The encoder is a hard single-instance service (it holds an
 *     exclusive lockfile), so a synchronous deflate on the request path would
 *     block every other caller for its whole duration. There is deliberately
 *     no *Sync export.
 *  2. TRY, KEEP IF SMALLER. Compression is attempted and kept only
 *     when it actually shrinks the payload; already-compressed media (JPEG,
 *     MP4, ZIP) silently rides raw.
 *  3. EMIT-TIME RATIO MIRROR. A payload that compresses BEYOND the
 *     serve-side ratio guard is emitted raw, because a compliant reader would
 *     refuse to inflate it. Legitimately hyper-compressible data (logs,
 *     padding, exports) must fail before broadcast, not after the money is
 *     spent.
 *
 * Vendored deliberately rather than imported from xchain-sdk: the services
 * ship as independent containers and do not share a node_modules tree. The
 * cross-service conformance test pins this module's decisions against the
 * SDK's when both checkouts are present.
 *
 ********************************************************************/

'use strict'

const zlib = require('zlib')
const {
    COMPRESSION_CODE_DEFLATE_RAW,
    COMPRESSION_MAX_RATIO,
    COMPRESSION_MAX_INPUT_BYTES
} = require('./validator.js')

// FILE v0 field indices in the FULL action string (ACTION token included):
// FILE|0|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION
//  0    1   2    3     4     5       6            7            8            9             10
const GATE_TICKER_FIELD_INDEX = 6
const COMPRESSION_FIELD_INDEX = 10

// deflate-raw, async. Rejects on zlib failure; the caller decides what a
// failure means (the encoder treats it as "emit raw").
function deflateRawAsync(input){
    return new Promise((resolve, reject) => {
        zlib.deflateRaw(input, (err, result) => err ? reject(err) : resolve(result))
    })
}

// Is this action string a FILE v0? COMPRESSION is a FILE field; setting it on
// anything else would be meaningless at best and a lying marker at worst.
function isFileV0Action(actionString){
    if (typeof actionString !== 'string' || actionString.length === 0) return false
    const parts = actionString.split('|')
    return String(parts[0]).toUpperCase() === 'FILE' && String(parts[1]) === '0'
}

// Is this FILE token-gated? Load-bearing, see the carve-out in
// compressPayloadForAction below.
function isGatedFileAction(actionString){
    if (!isFileV0Action(actionString)) return false
    const parts = actionString.split('|')
    if (parts.length <= GATE_TICKER_FIELD_INDEX) return false
    return String(parts[GATE_TICKER_FIELD_INDEX]).length > 0
}

// Read the COMPRESSION field verbatim, or '' when absent/not a FILE v0.
function compressionFieldOf(actionString){
    if (!isFileV0Action(actionString)) return ''
    const parts = actionString.split('|')
    if (parts.length <= COMPRESSION_FIELD_INDEX) return ''
    return String(parts[COMPRESSION_FIELD_INDEX])
}

// Return `actionString` with COMPRESSION set to `value`, padding intermediate
// optional fields. Setting '' strips it (and any now-trailing empties), so a
// non-compressed FILE stays BYTE-IDENTICAL to what the pre-Part-B encoder
// produced; that byte-identity is what keeps historical replay clean.
function withCompressionField(actionString, value){
    const parts = String(actionString).split('|')
    while (parts.length <= COMPRESSION_FIELD_INDEX) parts.push('')
    parts[COMPRESSION_FIELD_INDEX] = String(value == null ? '' : value)
    while (parts.length > 2 && parts[parts.length - 1] === '') parts.pop()
    return parts.join('|')
}

// SIZE CEILINGS ARE NOT THIS PASS'S JOB (AML #5308). validator.js measures the
// caller's PRE-compression bytes and refuses an oversize payload before this
// runs, so compression never rescues one; it only shrinks what is already
// admissible. Deliberate: xchain-sdk and xchain-wallet publish the same
// pre-compression cap and cannot see whether a given encoder deployment has
// compression on. Widening it is a three-repo change, not a carve-out here or
// in validateCombinedDataLength.
/**
 * Decide, and apply, transparent compression for one create_tx payload.
 *
 * @param {string|null} actionString - the caller's ACTION string.
 * @param {Buffer} rawDataBuffer - the caller's rawData bytes.
 * @param {object} [options]
 * @param {number} [options.maxRatio]
 * @param {number} [options.maxInputBytes]
 * @param {boolean} [options.explicit=true] - did the CALLER ask for compression,
 *   or is this the encoder's default pass? It decides what the guards below do
 *   when a payload cannot be compressed safely. An explicit request that cannot
 *   be honoured is an error the caller must see (they asked for something this
 *   payload cannot have). The DEFAULT pass runs over every action, most of which
 *   are not compressible FILEs at all, so the same conditions are ordinary facts
 *   about the payload and it rides raw. Getting this backwards would mean
 *   turning the default on breaks every SEND that carries rawData.
 * @returns {Promise<{data: string, rawData: Buffer, compressed: boolean,
 *                    rawLength: number, storedLength: number, reason: string|null}>}
 *   `data` and `rawData` are what the transaction must actually carry.
 * @throws TypeError when compression was explicitly requested but cannot be
 *   applied safely (see the guards below: they fail CLOSED, because emitting
 *   compressed bytes without a correct marker publishes permanently
 *   unreadable data, and the money is already spent by the time anyone finds
 *   out).
 */
async function compressPayloadForAction(actionString, rawDataBuffer, options = {}){
    const maxRatio = (options.maxRatio === undefined) ? COMPRESSION_MAX_RATIO : options.maxRatio
    const maxInputBytes = (options.maxInputBytes === undefined) ? COMPRESSION_MAX_INPUT_BYTES : options.maxInputBytes
    const explicit = (options.explicit === undefined) ? true : !!options.explicit

    const unchanged = (reason) => ({
        data: actionString,
        rawData: rawDataBuffer,
        compressed: false,
        rawLength: rawDataBuffer ? rawDataBuffer.length : 0,
        storedLength: rawDataBuffer ? rawDataBuffer.length : 0,
        reason
    })

    // Nothing to compress. Not an error: a caller may set compress broadly and
    // send payload-free actions through the same path.
    if (!rawDataBuffer || rawDataBuffer.length === 0) return unchanged('no-payload')

    // A guard that a caller must be told about, but that the default pass simply
    // routes around. `reason` is what the encoder reports as why the payload
    // rode raw, so a silent skip is still an observable one.
    const refuse = (ErrorClass, reason, message) => {
        if (explicit) throw new ErrorClass(message)
        return unchanged(reason)
    }

    // GUARD 1: COMPRESSION is a FILE v0 field. Compressing another action's
    // payload would produce bytes no reader can reconstruct, because there is
    // nowhere to record that they were compressed.
    if (!isFileV0Action(actionString))
        return refuse(TypeError, 'not-a-file-action',
            'Compression requested, but COMPRESSION is a FILE v0 field: ' +
            'refusing to compress a payload whose action cannot carry the marker.')

    // GUARD 2: gated FILEs are carved out, and this is the subtle one.
    //
    // On a gated FILE, COMPRESSION=1 means "inflate AFTER decrypt":
    // the field describes the PLAINTEXT, compressed by the client before
    // encryption. If the encoder also compressed the ciphertext and set the
    // same field, the marker would be ambiguous and a reader would try to
    // inflate ciphertext. So a gated FILE's COMPRESSION field belongs solely
    // to whoever performed the compress-then-encrypt, and the encoder passes
    // it through untouched.
    //
    // (In practice GCM ciphertext is incompressible, so try-and-keep would
    // almost always emit raw anyway. Almost is not a guarantee, and the
    // failure mode is permanently unreadable published data.)
    if (isGatedFileAction(actionString))
        return refuse(TypeError, 'gated-file',
            'Compression requested for a token-gated FILE. On a gated FILE the ' +
            'COMPRESSION field means inflate-after-decrypt and belongs to the client that ' +
            'performed compress-then-encrypt; the encoder must not set it. ' +
            'Compress the plaintext before encrypting and pass the field in the action string.')

    // GUARD 3: never overwrite a marker the caller already set. If a caller
    // asserts a codec, those bytes are theirs; silently re-compressing them
    // would double-encode.
    const declared = compressionFieldOf(actionString)
    if (declared.length > 0)
        return refuse(TypeError, 'codec-already-declared',
            `Compression requested, but the action already declares COMPRESSION='${declared}'. ` +
            'Refusing to re-compress bytes whose codec the caller already asserted.')

    // GUARD 4: pre-compression input cap.
    if (rawDataBuffer.length > maxInputBytes)
        return refuse(RangeError, 'over-input-cap',
            `Payload of ${rawDataBuffer.length} bytes exceeds the ` +
            `${maxInputBytes}-byte compression input cap.`)

    let deflated
    try {
        deflated = await deflateRawAsync(rawDataBuffer)
    } catch (err) {
        // A zlib failure is not fatal to the transaction: the uncompressed
        // payload is still perfectly valid, so degrade rather than refuse.
        console.warn('Compression skipped, deflate failed:', err && err.message ? err.message : err)
        return unchanged('deflate-failed')
    }

    // Try, keep if smaller.
    if (deflated.length >= rawDataBuffer.length) return unchanged('not-smaller')

    // Emit-time mirror of the serve-side ratio guard.
    if ((rawDataBuffer.length / deflated.length) > maxRatio) return unchanged('ratio-guard')

    return {
        data: withCompressionField(actionString, COMPRESSION_CODE_DEFLATE_RAW),
        rawData: deflated,
        compressed: true,
        rawLength: rawDataBuffer.length,
        storedLength: deflated.length,
        reason: null
    }
}

module.exports = {
    compressPayloadForAction,
    withCompressionField,
    compressionFieldOf,
    isFileV0Action,
    isGatedFileAction,
    COMPRESSION_CODE_DEFLATE_RAW,
    COMPRESSION_MAX_RATIO,
    COMPRESSION_MAX_INPUT_BYTES,
    GATE_TICKER_FIELD_INDEX,
    COMPRESSION_FIELD_INDEX
}
