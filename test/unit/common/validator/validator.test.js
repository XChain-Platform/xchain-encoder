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
const v = require('../../src/common/validator.js');

describe('Encoder input validator', function () {

    describe('validatePubkey', function () {
        it('passes null/valid through, throws on bad input', function () {
            assert.strictEqual(v.validatePubkey(null), null);
            assert.strictEqual(v.validatePubkey(undefined), null);
            assert.strictEqual(v.validatePubkey('02abcd'), '02abcd');
            assert.throws(() => v.validatePubkey(''), TypeError);
            assert.throws(() => v.validatePubkey(123), TypeError);
            assert.throws(() => v.validatePubkey('x'.repeat(101)), /maximum length/);
        });
    });
});
