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

    describe('validateAddress', function () {
        it('accepts a valid string (incl. exactly 100 chars); rejects empty, non-string, and over-length', function () {
            assert.strictEqual(v.validateAddress('addr'), 'addr');
            assert.strictEqual(v.validateAddress('x'.repeat(100)), 'x'.repeat(100));
            assert.throws(() => v.validateAddress(''), /non-empty string/);
            assert.throws(() => v.validateAddress({}), /non-empty string/);
            assert.throws(() => v.validateAddress([]), /non-empty string/);
            assert.throws(() => v.validateAddress(123), /non-empty string/);
            assert.throws(() => v.validateAddress(null), /non-empty string/);
            assert.throws(() => v.validateAddress('x'.repeat(101)), /maximum length/);
        });
    });
});
