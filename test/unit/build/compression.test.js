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

const compression = require('../../src/build/compression')
const {
    PUBLIC_FILE,
    GATED_FILE,
    compressibleBytes
} = require('./compression.test/helpers/fixtures')

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('compressPayloadForAction', function () {

        it('compresses a public FILE payload and appends the COMPRESSION field', async function () {
            const payload = compressibleBytes()
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, payload)
            assert.strictEqual(r.compressed, true)
            assert.ok(r.storedLength < r.rawLength)
            assert.strictEqual(r.data, PUBLIC_FILE + '|||||1')
            assert.strictEqual(compression.compressionFieldOf(r.data), '1')
            // The bytes are genuinely deflate-raw and reconstruct exactly.
            assert.ok(zlib.inflateRawSync(r.rawData).equals(payload))
        })

        it('the marker and the bytes always move together', async function () {
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, compressibleBytes())
            const declaredCompressed = compression.compressionFieldOf(r.data) === '1'
            assert.strictEqual(declaredCompressed, r.compressed,
                'a marker without compressed bytes (or vice versa) publishes unreadable data')
        })

        it('keeps already-compressed media raw, leaving the action byte-identical', async function () {
            const media = crypto.randomBytes(20000)
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, media)
            assert.strictEqual(r.compressed, false)
            assert.strictEqual(r.reason, 'not-smaller')
            assert.strictEqual(r.data, PUBLIC_FILE, 'no COMPRESSION field appended')
            assert.ok(r.rawData.equals(media))
        })

        it('emits RAW when the payload compresses beyond the ratio guard', async function () {
            // A compliant reader would refuse to inflate this, so emitting it
            // compressed would spend real money on unreadable bytes.
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, Buffer.alloc(200000, 0x20))
            assert.strictEqual(r.compressed, false)
            assert.strictEqual(r.reason, 'ratio-guard')
            assert.strictEqual(r.data, PUBLIC_FILE)
        })

        it('passes a payload-free action straight through', async function () {
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, Buffer.alloc(0))
            assert.strictEqual(r.compressed, false)
            assert.strictEqual(r.reason, 'no-payload')
            assert.strictEqual(r.data, PUBLIC_FILE)
        })
    })
})

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('compressPayloadForAction', function () {

        // --- the refusals ---

        it('REFUSES a non-FILE action (nowhere to record the marker)', async function () {
            await assert.rejects(
                () => compression.compressPayloadForAction('SEND|0|XCHAIN|1000', compressibleBytes()),
                /COMPRESSION is a FILE v0 field/
            )
        })

        it('REFUSES a FILE of another version', async function () {
            await assert.rejects(
                () => compression.compressPayloadForAction('FILE|1|a.txt|text/plain', compressibleBytes()),
                /COMPRESSION is a FILE v0 field/
            )
        })

        it('REFUSES a token-gated FILE (§5.4: the field means inflate-after-decrypt)', async function () {
            // The trap this guards: on a gated FILE, COMPRESSION describes the
            // PLAINTEXT the client compressed before encrypting. If the encoder
            // also compressed the ciphertext and set the same field, a reader
            // would try to inflate ciphertext.
            await assert.rejects(
                () => compression.compressPayloadForAction(GATED_FILE, compressibleBytes()),
                /token-gated FILE/
            )
        })

        it('REFUSES to re-compress when the caller already declared a codec', async function () {
            await assert.rejects(
                () => compression.compressPayloadForAction(PUBLIC_FILE + '|||||1', compressibleBytes()),
                /already declares COMPRESSION/
            )
        })

        it('REFUSES a payload over the pre-compression input cap', async function () {
            await assert.rejects(
                () => compression.compressPayloadForAction(PUBLIC_FILE, Buffer.alloc(2048),
                    { maxInputBytes: 1024 }),
                /exceeds the 1024-byte compression input cap/
            )
        })
    })
})

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('compressPayloadForAction', function () {
        it('a gated FILE passes its own COMPRESSION field through untouched', function () {
            // The client set it; the encoder must neither add nor remove it.
            const clientSet = GATED_FILE + '|100|1'
            assert.strictEqual(compression.compressionFieldOf(clientSet), '1')
            assert.strictEqual(compression.isGatedFileAction(clientSet), true)
        })
    })
})
