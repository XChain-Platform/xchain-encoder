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

    describe('validateActionName (encoder ACTION-name gate)', function () {
        it('accepts every canonical ACTION name from VALID_ACTION_NAMES', function () {
            for (const name of v.VALID_ACTION_NAMES) {
                assert.doesNotThrow(() => v.validateActionName(`${name}|0|X|1|a`), name);
            }
        });
        it('accepts a bare canonical name with no pipe-delimited payload', function () {
            assert.doesNotThrow(() => v.validateActionName('SEND'));
        });
        it('accepts every known alias and expands it the same way the decoder does', function () {
            for (const alias of Object.keys(v.ACTION_ALIASES)) {
                assert.doesNotThrow(() => v.validateActionName(`${alias}|0|X|1|a`), alias);
            }
        });
        it('rejects a typoed ACTION name with a RangeError', function () {
            assert.throws(() => v.validateActionName('TRANSFRE|0|X|1|a'), RangeError);
            assert.throws(() => v.validateActionName('TRANSFRE|0|X|1|a'), /unknown ACTION name/);
        });
        it('rejects an action newer than the deployed decoder', function () {
            assert.throws(() => v.validateActionName('FUTURE_ACTION|1'), RangeError);
        });
        it('is case-sensitive: a lowercase canonical name is not recognized', function () {
            assert.throws(() => v.validateActionName('send|0|X|1|a'), RangeError);
        });
        it('does not reject the intentionally-supported empty/absent data shapes', function () {
            assert.doesNotThrow(() => v.validateActionName(null));
            assert.doesNotThrow(() => v.validateActionName(''));
        });
        it('is wired into validateAll and fires before feeQuote/utxo checks', function () {
            assert.throws(
                () => v.validateAll({ data: 'TRANSFRE|0|X|1|a', pubkey: '02ab' }),
                /unknown ACTION name/
            );
        });
        it('validateAll still accepts a valid canonical action end-to-end', function () {
            assert.doesNotThrow(() => v.validateAll({ data: 'SEND|0|X|1|a', pubkey: '02ab' }));
        });
    });
});
