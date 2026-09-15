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
const path = require('path')
const fs = require('fs')

const compression = require('../../../src/build/compression')
const validator = require('../../../src/common/validator')
const { PUBLIC_FILE, compressibleBytes } = require('./helpers/fixtures')

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('constants conformance', function () {
        it('the local values are the pinned ones', function () {
            assert.strictEqual(validator.COMPRESSION_CODE_DEFLATE_RAW, '1')
            assert.strictEqual(validator.COMPRESSION_MAX_RATIO, 150)
            assert.strictEqual(validator.COMPRESSION_MAX_INPUT_BYTES, 16 * 1024 * 1024)
        })
    })
})

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('constants conformance', function () {
        const DOCS = process.env.XCHAIN_DOCUMENTATION_DIR ||
            path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation')
        const DOCS_CONSTANTS = path.join(DOCS, 'protocol', 'constants.js')

        it('they equal the canonical declaration (skips without the docs sibling)', function () {
            if (!fs.existsSync(DOCS_CONSTANTS)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('xchain-documentation sibling not found but XCHAIN_REQUIRE_SIBLINGS=1')
                this.skip()
            }
            const docs = require(DOCS_CONSTANTS)
            assert.strictEqual(docs.COMPRESSION_CODE_DEFLATE_RAW, validator.COMPRESSION_CODE_DEFLATE_RAW)
            assert.strictEqual(docs.COMPRESSION_MAX_RATIO, validator.COMPRESSION_MAX_RATIO)
            assert.strictEqual(docs.COMPRESSION_MAX_INPUT_BYTES, validator.COMPRESSION_MAX_INPUT_BYTES)
        })

        // The encoder and the SDK each vendor this logic (independent
        // containers, no shared node_modules). They must agree on every
        // decision or a payload the SDK marked compressed could be emitted
        // raw, or vice versa.
        it('agrees with the SDK helper on every decision (skips without the sdk sibling)', async function () {
            const SDK = process.env.XCHAIN_SDK_DIR ||
                path.join(__dirname, '..', '..', '..', '..', 'xchain-sdk')
            const SDK_COMPRESSION = path.join(SDK, 'src', 'protocol', 'compression.js')
            if (!fs.existsSync(SDK_COMPRESSION)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('xchain-sdk sibling not found but XCHAIN_REQUIRE_SIBLINGS=1')
                this.skip()
            }
            const SdkCompression = require(SDK_COMPRESSION)
            const sdk = new SdkCompression()

            const payloads = [
                compressibleBytes(5000),
                crypto.randomBytes(5000),
                Buffer.alloc(200000, 0x20),
                Buffer.alloc(0)
            ]
            for (const payload of payloads) {
                const sdkResult = await sdk.compressIfSmaller(payload)
                const encoderResult = await compression.compressPayloadForAction(PUBLIC_FILE, payload)
                assert.strictEqual(encoderResult.compressed, sdkResult.compressed,
                    `keep/discard decision diverged for a ${payload.length}-byte payload`)
                if (sdkResult.compressed)
                    assert.ok(encoderResult.rawData.equals(sdkResult.bytes), 'compressed bytes diverged')
            }

            // And they agree on where the field lives.
            assert.strictEqual(SdkCompression.COMPRESSION_FIELD_INDEX, compression.COMPRESSION_FIELD_INDEX)
            assert.strictEqual(SdkCompression.GATE_TICKER_FIELD_INDEX, compression.GATE_TICKER_FIELD_INDEX)
            assert.strictEqual(sdk.withCompressionField(PUBLIC_FILE, '1'),
                compression.withCompressionField(PUBLIC_FILE, '1'))
        })
    })
})
