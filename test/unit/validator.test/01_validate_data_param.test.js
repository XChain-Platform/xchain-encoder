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

describe('Encoder input validator', function () {

    describe('validateDataParam', function () {
        it('null passes, string passes, non-string throws with field name', function () {
            assert.strictEqual(v.validateDataParam(null, 'data'), null);
            assert.strictEqual(v.validateDataParam('hello', 'data'), 'hello');
            assert.throws(() => v.validateDataParam(5, 'rawData'), /rawData must be a string/);
        });

        // The emitter converts data with Buffer.from(...,'utf8') and rawData
        // with Buffer.from(...,'binary'), and neither is reversible for every JS string.
        // A validated value that the wire encoding mutates can never be reconstructed by
        // the decoder, so it must be refused here rather than silently corrupted.
        // Built with fromCharCode so this source file stays plain ASCII.
        const LONE_SURROGATE = String.fromCharCode(0xD800);
        const ABOVE_LATIN1 = String.fromCharCode(0x0100);
        const BINARY_BYTES = String.fromCharCode(0x00, 0x01, 0xFF, 0x80, 0x7F);

        it('rejects a data string that is not well-formed Unicode (utf8 would emit U+FFFD)', function () {
            assert.throws(() => v.validateDataParam(`ISSUE|0|TICK${LONE_SURROGATE}`, 'data'), RangeError);
            assert.throws(() => v.validateDataParam(LONE_SURROGATE, 'data'), /not well-formed Unicode/);
        });

        it('rejects a rawData code point above U+00FF (latin-1 would truncate it)', function () {
            assert.throws(() => v.validateDataParam(ABOVE_LATIN1, 'rawData'), RangeError);
            assert.throws(() => v.validateDataParam(`meta${ABOVE_LATIN1}`, 'rawData'), /above U\+00FF/);
        });

        it('still accepts every value the wire encodings carry losslessly', function () {
            // Full-range binary rawData (control bytes and 0x80-0xFF) is the normal shape.
            assert.strictEqual(v.validateDataParam(BINARY_BYTES, 'rawData'), BINARY_BYTES);
            // Well-formed non-ASCII text in `data` round-trips through utf8 and stays legal.
            const emoji = `MESSAGE|0|${String.fromCodePoint(0x1F600)}`;
            assert.strictEqual(v.validateDataParam(emoji, 'data'), emoji);
            // A surrogate PAIR is well-formed; only an unpaired half is refused.
            assert.strictEqual(v.validateDataParam(LONE_SURROGATE + String.fromCharCode(0xDC00), 'data'),
                LONE_SURROGATE + String.fromCharCode(0xDC00));
        });
    });
});
