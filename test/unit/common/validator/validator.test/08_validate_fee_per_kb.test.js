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
const v = require('../../../../../src/common/validator.js');

describe('Encoder input validator', function () {

    describe('validateFeePerKb', function () {
        it('null/false pass; rejects non-finite and non-positive', function () {
            assert.strictEqual(v.validateFeePerKb(null), null);
            assert.strictEqual(v.validateFeePerKb(false), null);
            assert.strictEqual(v.validateFeePerKb('2.5'), 2.5);
            assert.throws(() => v.validateFeePerKb('nope'), TypeError);
            assert.throws(() => v.validateFeePerKb(Infinity), TypeError);
            assert.throws(() => v.validateFeePerKb(0), RangeError);
            assert.throws(() => v.validateFeePerKb(-3), RangeError);
        });
        it('rejects hex, scientific, boolean, array, and object forms Number() would coerce', function () {
            assert.throws(() => v.validateFeePerKb('0x20'), TypeError);   // hex string -> 32
            assert.throws(() => v.validateFeePerKb('1e3'), TypeError);    // scientific -> 1000
            assert.throws(() => v.validateFeePerKb(true), TypeError);     // boolean -> 1
            assert.throws(() => v.validateFeePerKb([50]), TypeError);     // array -> 50
            assert.throws(() => v.validateFeePerKb({}), TypeError);       // object -> NaN
        });
    });
});
