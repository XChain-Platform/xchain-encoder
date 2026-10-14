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
 * Validator -32602 messages quote at most a short prefix of a caller string,
 * the rule validateActionName set first, so a multi-megabyte junk value is
 * never sent back whole in the error.
 ********************************************************************/

'use strict';

const assert = require('assert');
const v = require('../../../../src/common/validator.js');
const { validateCreateTxOptions, validateFee } = require('../../../../src/common/validator/fee_and_utxo_checks.js');
const { validateOptionalBoolean, parseSatoshiAmount, truncateForMessage } = require('../../../../src/common/validator/value_checks.js');
const { ParamTypeError, ParamRangeError } = require('../../../../src/build/errors');

const LONG = 'Z'.repeat(100000);
const LONG_DIGITS = '9'.repeat(100000);
const MAX_MESSAGE = 400;

// Assert fn throws errClass with a short message that does not carry the input.
function assertShortRefusal(fn, errClass, input) {
    assert.throws(fn, (err) => {
        assert.ok(err instanceof errClass, `expected ${errClass.name}, got ${err && err.constructor.name}`);
        assert.ok(err.message.length < MAX_MESSAGE, `message is ${err.message.length} chars`);
        assert.ok(!err.message.includes(input), 'message echoes the whole input');
        return true;
    });
}

describe('Validator messages truncate caller strings', function () {
    it('truncates an oversized encoding, fee, options key and boolean string', function () {
        assertShortRefusal(() => v.validateEncoding(LONG), ParamTypeError, LONG);
        assertShortRefusal(() => validateFee(LONG), ParamTypeError, LONG);
        assertShortRefusal(() => validateCreateTxOptions({ [LONG]: true }), ParamTypeError, LONG);
        assertShortRefusal(() => validateOptionalBoolean(LONG, 'rbf'), ParamTypeError, LONG);
    });

    it('truncates an oversized all-digit satoshi amount, with and without allowBig', function () {
        assertShortRefusal(() => parseSatoshiAmount(LONG_DIGITS, 'value'), ParamRangeError, LONG_DIGITS);
        assertShortRefusal(() => parseSatoshiAmount(LONG_DIGITS, 'value', { allowBig: true }), ParamRangeError, LONG_DIGITS);
    });

    it('truncates an oversized unknown create_tx param name', function () {
        assertShortRefusal(() => v.validateAll({ data: 'SEND', pubkey: '02ab', [LONG]: 1 }), ParamTypeError, LONG);
    });

    it('names the type of a non-string encoding instead of [object Object]', function () {
        assert.throws(() => v.validateEncoding({}), (err) => {
            assert.ok(err instanceof ParamTypeError);
            assert.match(err.message, /object/);
            assert.ok(!err.message.includes('[object Object]'), err.message);
            return true;
        });
    });

    it('leaves a short value whole and marks a cut one with its length', function () {
        assert.strictEqual(truncateForMessage('exactInput'), 'exactInput');
        assert.strictEqual(truncateForMessage('x'.repeat(32)), 'x'.repeat(32));
        assert.strictEqual(truncateForMessage('x'.repeat(33)), `${'x'.repeat(32)}...(33 chars)`);
    });
});
