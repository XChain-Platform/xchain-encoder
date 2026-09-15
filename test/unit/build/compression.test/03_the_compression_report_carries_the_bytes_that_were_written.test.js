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
 * Emit-side FILE payload compression (spec Part B), encoder side.
 *
 * The load-bearing assertions here are the REFUSALS. Compression is opt-in and
 * mutates the published ACTION string, so every way it could publish
 * permanently unreadable bytes has to fail closed BEFORE broadcast:
 *  - a non-FILE action has nowhere to record the marker;
 *  - a GATED FILE's COMPRESSION field means inflate-after-decrypt and belongs
 *    to the client that did compress-then-encrypt, never to the encoder;
 *  - a caller-declared codec is never silently re-compressed;
 *  - hyper-compressible payloads are emitted raw, because a compliant reader
 *    would refuse to inflate them (emit-time mirror of the serve guard).
 *
 * Plus the two properties that make the feature safe to ship dark:
 *  - the default (ON, per spec §5.2) and the explicit opt-out;
 *  - the estimator prices the COMPRESSED bytes, not the caller's original.
 */

'use strict'

const assert = require('assert')
const crypto = require('crypto')
const zlib = require('zlib')

const compression = require('../../../../src/build/compression')
const {
    PUBLIC_FILE,
    compressibleBytes,
    makeEncoder,
    segwitUtxo,
    callerAddress
} = require('./helpers/fixtures')

describe('encoder FILE payload compression (spec Part B)', function () {
    // Compression rewrites the action string and replaces the payload
    // in place, and a boolean plus two lengths does not let anyone rebuild the
    // result: the caller's confirm check described a string the PSBT does not
    // carry (so a compressible FILE upload refused itself as tampered), and the
    // phase-2 reveal was re-derived from the caller's uncompressed payload,
    // compiling a carrier that hashes to nothing the commit created. The report
    // now carries the WRITTEN bytes, both halves, so the rebuild is a copy
    // rather than a re-derivation.
    describe('the compression report carries the bytes that were written', function () {

        it('reports the written action string and the stored payload', async function () {
            const encoder = makeEncoder()
            const network = encoder.network
            const raw = compressibleBytes(4000)

            const result = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, PUBLIC_FILE,
                raw.toString('binary'),
                null, false, 'P2WSH', callerAddress(network))

            assert.strictEqual(result.compression.compressed, true)
            assert.strictEqual(compression.compressionFieldOf(result.compression.data), '1',
                'the reported string is the one carrying the marker')
            assert.strictEqual(result.compression.data,
                compression.withCompressionField(PUBLIC_FILE, '1'),
                'and it is the caller\'s own string with nothing but COMPRESSION set')
            // The stored payload, in the same Latin-1 form every rawData
            // parameter takes, and it really is the caller's bytes deflated.
            const stored = Buffer.from(result.compression.rawData, 'binary')
            assert.strictEqual(stored.length, result.compression.storedLength)
            assert.ok(zlib.inflateRawSync(stored).equals(raw))
        })

        it('says nothing extra when compression did not fire', async function () {
            const encoder = makeEncoder()
            const network = encoder.network
            const result = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null,
                'FILE|0|photo.jpg|image/jpeg|Photo|', crypto.randomBytes(3000).toString('binary'),
                null, false, 'P2WSH', callerAddress(network))
            assert.strictEqual(result.compression.compressed, false)
            assert.strictEqual(result.compression.data, undefined,
                'an untouched action string is already the caller\'s own')
            assert.strictEqual(result.compression.rawData, undefined)
        })
    })
})

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('the compression report carries the bytes that were written', function () {
        it('a reveal REBUILT FROM THE REPORT reproduces the commit carrier byte for byte', async function () {
            // The decisive property: phase 2 chunks script.compile([data, rawData])
            // and must land on the same carriers phase 1 committed to, or the
            // reveal cannot spend the commit and the funds are stranded.
            const encoder = makeEncoder()
            const network = encoder.network
            const raw = compressibleBytes(4000).toString('binary')

            const commit = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, PUBLIC_FILE, raw,
                null, false, 'P2WSH', callerAddress(network))
            assert.ok(commit.carrierScripts.length > 1, 'a multi-carrier payload, as a real FILE is')

            // Rebuild from what the encoder said it wrote, compression off: this
            // is exactly what the SDK now hands spendP2sh.
            encoder.clearReservations()
            const rebuilt = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null,
                commit.compression.data, commit.compression.rawData,
                null, false, 'P2WSH', callerAddress(network), null, null, null,
                true, null, null, null, false, false)
            assert.deepStrictEqual(rebuilt.carrierScripts, commit.carrierScripts,
                'the reveal reproduces the commit\'s chunks exactly')
        })

        it('the marker WITHOUT the stored bytes builds a different carrier (why both halves ride)', async function () {
            // The withdrawn wallet-side remedy, measured: re-derive the marker
            // locally and keep the caller's uncompressed payload, and the reveal
            // compiles carriers the commit never created. This is the stranding.
            const encoder = makeEncoder()
            const network = encoder.network
            const raw = compressibleBytes(4000).toString('binary')

            const commit = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, PUBLIC_FILE, raw,
                null, false, 'P2WSH', callerAddress(network))

            encoder.clearReservations()
            const rederived = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null,
                commit.compression.data, raw,
                null, false, 'P2WSH', callerAddress(network), null, null, null,
                true, null, null, null, false, false)
            assert.notDeepStrictEqual(rederived.carrierScripts, commit.carrierScripts,
                'a reveal built this way could never spend the commit')
        })
    })
})
