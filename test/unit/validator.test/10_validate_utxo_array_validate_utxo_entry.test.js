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

    describe('validateUtxoArray / validateUtxoEntry', function () {
        const goodUtxo = () => ({ txid: HEX64, vout: 0, value: 1000, scriptPubKey: '76a914' });

        it('null passes; non-array and over-cap throw', function () {
            assert.strictEqual(v.validateUtxoArray(null), null);
            assert.throws(() => v.validateUtxoArray('no'), /must be an array/);
            const tooMany = Array.from({ length: v.MAX_UTXO_COUNT + 1 }, goodUtxo);
            assert.throws(() => v.validateUtxoArray(tooMany), /exceeds maximum/);
        });

        it('coerces vout/value and defaults confirmations', function () {
            const arr = [{ txid: HEX64, vout: '2', value: '500', scriptPubKey: 'aa' }];
            const out = v.validateUtxoArray(arr);
            assert.strictEqual(out[0].vout, 2);
            assert.strictEqual(out[0].value, 500);
            assert.strictEqual(out[0].confirmations, 0);
        });

        it('rejects each malformed field', function () {
            assert.throws(() => v.validateUtxoEntry(null, 0), /must be an object/);
            assert.throws(() => v.validateUtxoEntry([], 0), /must be an object/);
            assert.throws(() => v.validateUtxoEntry({ ...goodUtxo(), txid: 'short' }, 0), /64-character hex/);
            assert.throws(() => v.validateUtxoEntry({ ...goodUtxo(), vout: -1 }, 1), /non-negative integer/);
            assert.throws(() => v.validateUtxoEntry({ ...goodUtxo(), value: -5 }, 2), RangeError);
            assert.throws(() => v.validateUtxoEntry({ ...goodUtxo(), scriptPubKey: '' }, 3), /scriptPubKey/);
        });

        it('rejects vout values bare Number() would coerce to a plausible index', function () {
            // null/''/false/[] all Number()-coerce to 0 and once validated as
            // vout 0 the encoder would spend a different outpoint (txid:0).
            for (const bad of [null, '', false, true, [], [7], '2.0', '0x2']) {
                assert.throws(
                    () => v.validateUtxoEntry({ ...goodUtxo(), vout: bad }, 0),
                    /vout must be a non-negative integer/,
                    `vout ${JSON.stringify(bad)} must be rejected`
                );
            }
            // integers and integer strings still pass
            assert.strictEqual(v.validateUtxoEntry({ ...goodUtxo(), vout: 5 }, 0).vout, 5);
            assert.strictEqual(v.validateUtxoEntry({ ...goodUtxo(), vout: '5' }, 0).vout, 5);
        });

        it('preserves an explicit confirmations value', function () {
            const out = v.validateUtxoArray([{ ...goodUtxo(), confirmations: 6 }]);
            assert.strictEqual(out[0].confirmations, 6);
        });

        it('coerces numeric-string confirmations and rejects untyped values', function () {
            const out = v.validateUtxoArray([{ ...goodUtxo(), confirmations: '3' }]);
            assert.strictEqual(out[0].confirmations, 3);
            assert.throws(() => v.validateUtxoEntry({ ...goodUtxo(), confirmations: -1 }, 0), /confirmations must be a non-negative integer/);
            assert.throws(() => v.validateUtxoEntry({ ...goodUtxo(), confirmations: 1.5 }, 0), /confirmations must be a non-negative integer/);
            assert.throws(() => v.validateUtxoEntry({ ...goodUtxo(), confirmations: 'abc' }, 0), /confirmations must be a non-negative integer/);
            assert.throws(() => v.validateUtxoEntry({ ...goodUtxo(), confirmations: {} }, 0), /confirmations must be a non-negative integer/);
        });
    });
});
