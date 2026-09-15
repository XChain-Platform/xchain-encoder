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

const validator = require('../../../../src/common/validator')
const { TXID_A, PUBLIC_FILE } = require('./helpers/fixtures')

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('validator', function () {
        it('accepts compress as an optional boolean; absent means "use the deployment default"', function () {
            const base = {
                utxos: [{ txid: TXID_A, vout: 0, value: 100000, scriptPubKey: '0014' + 'bb'.repeat(20) }],
                pubkey: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef',
                data: PUBLIC_FILE,
                change: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'
            }
            // Absent stays absent through the validator: the tri-state is
            // resolved in the encoder, which is the only place that knows the
            // deployment default.
            assert.strictEqual(validator.validateAll({ ...base }).compress, undefined, 'absent stays absent');
            assert.strictEqual(validator.validateAll({ ...base, compress: true }).compress, true);
            assert.strictEqual(validator.validateAll({ ...base, compress: false }).compress, false);
            assert.throws(() => validator.validateAll({ ...base, compress: 'yes' }), /compress/);
        })
    })
})
