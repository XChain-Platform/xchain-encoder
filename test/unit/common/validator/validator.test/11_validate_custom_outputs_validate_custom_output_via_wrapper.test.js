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

    describe('validateCustomOutputs (+ validateCustomOutput via wrapper)', function () {
        it('null passes; non-array and over-cap throw', function () {
            assert.strictEqual(v.validateCustomOutputs(null), null);
            assert.throws(() => v.validateCustomOutputs('no'), /must be an array/);
            const tooMany = Array.from({ length: v.MAX_CUSTOM_OUTPUTS + 1 }, () => ({ address: 'a', value: 1 }));
            assert.throws(() => v.validateCustomOutputs(tooMany), /exceeds maximum/);
        });
        it('coerces value and rejects malformed entries', function () {
            const out = v.validateCustomOutputs([{ address: 'addr', value: '100' }]);
            assert.strictEqual(out[0].value, 100);
            assert.throws(() => v.validateCustomOutputs([null]), /must be an object/);
            assert.throws(() => v.validateCustomOutputs([{ address: '', value: 1 }]), /non-empty/);
            assert.throws(() => v.validateCustomOutputs([{ address: 'x'.repeat(101), value: 1 }]), /maximum length/);
            assert.throws(() => v.validateCustomOutputs([{ address: 'a', value: -1 }]), RangeError);
            // Interim safe dust rule: a 0-sat caller output is relay-rejected as
            // dust, so it is rejected at the boundary (matching validateFeeQuote).
            assert.throws(() => v.validateCustomOutputs([{ address: 'a', value: 0 }]), /must be a positive integer/);
            // A positive sub-dust value still passes the boundary (no dust floor yet).
            assert.strictEqual(v.validateCustomOutputs([{ address: 'a', value: 1 }])[0].value, 1);
        });
    });
});
