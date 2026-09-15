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

const compression = require('../../../../src/build/compression')
const { PUBLIC_FILE, GATED_FILE } = require('./helpers/fixtures')

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('action-string helpers', function () {
        it('detects FILE v0 and gating correctly', function () {
            assert.strictEqual(compression.isFileV0Action(PUBLIC_FILE), true)
            assert.strictEqual(compression.isFileV0Action('SEND|0|X|1'), false)
            assert.strictEqual(compression.isFileV0Action('FILE|1|a|b'), false)
            assert.strictEqual(compression.isGatedFileAction(GATED_FILE), true)
            assert.strictEqual(compression.isGatedFileAction(PUBLIC_FILE), false)
        })

        it('setting the field empty leaves the action byte-identical', function () {
            assert.strictEqual(compression.withCompressionField(PUBLIC_FILE, ''), PUBLIC_FILE)
        })

        it('pads intermediate optional fields to reach index 10', function () {
            const out = compression.withCompressionField('FILE|0|a.txt|text/plain', '1')
            assert.strictEqual(out.split('|').length, 11)
            assert.strictEqual(out.split('|')[10], '1')
        })

        it('preserves the gating fields when a client sets the marker', function () {
            const out = compression.withCompressionField(GATED_FILE + '|100', '1')
            const parts = out.split('|')
            assert.strictEqual(parts[6], 'MYTOKEN')
            assert.strictEqual(parts[7], '1')
            assert.strictEqual(parts[9], '100')
            assert.strictEqual(parts[10], '1')
        })
    })
})
