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

    describe('validateRawTxHex', function () {
        it('accepts well-formed hex and returns it', function () {
            assert.strictEqual(v.validateRawTxHex('deadbeef'), 'deadbeef');
        });
        it('rejects non-strings, empty, odd-length and non-hex input', function () {
            assert.throws(() => v.validateRawTxHex(null), /non-empty hex/);
            assert.throws(() => v.validateRawTxHex(42), /non-empty hex/);
            assert.throws(() => v.validateRawTxHex(''), /non-empty hex/);
            assert.throws(() => v.validateRawTxHex('abc'), /even-length hex/);
            assert.throws(() => v.validateRawTxHex('zz00'), /even-length hex/);
        });
        it('accepts hex between the p2shHex cap and the broadcast cap (an envelope reveal)', function () {
            // A signed TAPROOT envelope reveal is ~810,000 hex chars,
            // above MAX_RAW_TX_HEX_LENGTH (which still bounds p2shHex) but
            // within the broadcast_tx ceiling.
            const hex = 'ab'.repeat(v.MAX_RAW_TX_HEX_LENGTH / 2 + 1);
            assert.strictEqual(v.validateRawTxHex(hex), hex);
        });
        it('rejects hex above MAX_BROADCAST_TX_HEX_LENGTH', function () {
            assert.ok(v.MAX_BROADCAST_TX_HEX_LENGTH > v.MAX_RAW_TX_HEX_LENGTH);
            assert.throws(
                () => v.validateRawTxHex('ab'.repeat(v.MAX_BROADCAST_TX_HEX_LENGTH / 2 + 1)),
                /exceeds maximum length/
            );
        });
    });
});
