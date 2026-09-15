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
 * Unit tests for src/common/validator.js: centralized createTransaction input
 * validation. Every validator returns the coerced value or throws
 * TypeError/RangeError. validateCustomOutput / validateFeeQuote are exercised
 * through their array/validateAll wrappers (not individually exported).
 ********************************************************************/

const assert = require('assert');
const v = require('../../../src/common/validator.js');

const HEX64 = 'a'.repeat(64);

describe('Encoder input validator', function () {

    describe('validateP2shParams', function () {
        it('both-omitted yields nulls; mismatch throws', function () {
            assert.deepStrictEqual(v.validateP2shParams(null, false), { p2shHash: null, p2shHex: null });
            assert.throws(() => v.validateP2shParams(HEX64, null), /both be provided or both omitted/);
        });
        it('validates hash hex and non-empty hex; returns the pair', function () {
            assert.throws(() => v.validateP2shParams('bad', 'deadbeef'), /64-character hex/);
            assert.throws(() => v.validateP2shParams(HEX64, ''), /non-empty hex/);
            assert.deepStrictEqual(v.validateP2shParams(HEX64, 'deadbeef'), { p2shHash: HEX64, p2shHex: 'deadbeef' });
        });
        it('enforces hex shape and the raw-tx length cap on p2shHex', function () {
            assert.throws(() => v.validateP2shParams(HEX64, 'not-hex!'), /even-length hex/);
            assert.throws(() => v.validateP2shParams(HEX64, 'abc'), /even-length hex/);
            assert.throws(
                () => v.validateP2shParams(HEX64, 'ab'.repeat(v.MAX_RAW_TX_HEX_LENGTH / 2 + 1)),
                /exceeds maximum length/
            );
            // Exactly at the cap is accepted (shape-valid hex)
            const atCap = 'ab'.repeat(v.MAX_RAW_TX_HEX_LENGTH / 2);
            assert.strictEqual(v.validateP2shParams(HEX64, atCap).p2shHex, atCap);
        });
    });
});
