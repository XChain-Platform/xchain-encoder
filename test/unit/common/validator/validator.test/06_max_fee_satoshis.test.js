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

    describe('MAX_FEE_SATOSHIS', function () {
        it('is pinned at 21,000 BTC in satoshis, not 21M BTC', function () {
            // A misread of '21M BTC' here would invite a 1000x 'repair' that
            // would loosen validateFee/validateDust/validateFeeQuote together.
            assert.strictEqual(v.MAX_FEE_SATOSHIS, 2_100_000_000_000);
            assert.strictEqual(v.MAX_FEE_SATOSHIS / 100_000_000, 21_000);
        });
    });
});
