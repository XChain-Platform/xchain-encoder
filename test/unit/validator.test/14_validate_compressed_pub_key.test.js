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

    describe('validateCompressedPubKey', function () {
        it('null passes; enforces the 02/03 + 64-hex shape', function () {
            assert.strictEqual(v.validateCompressedPubKey(null), null);
            assert.strictEqual(v.validateCompressedPubKey('02' + HEX64), '02' + HEX64);
            assert.throws(() => v.validateCompressedPubKey('04' + HEX64), /02 or 03/);
            assert.throws(() => v.validateCompressedPubKey('nope'), TypeError);
        });
    });
});
