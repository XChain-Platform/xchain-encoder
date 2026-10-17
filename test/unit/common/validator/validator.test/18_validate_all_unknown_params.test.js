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
 * create_tx refuses an unknown top-level param, the same rule the options
 * bag follows: a misspelled money-path setting (unconfirmed, feePerKb, rbf,
 * compressedPubKey) must fail loudly rather than fall back to a default.
 ********************************************************************/

const assert = require('assert');
const v = require('../../../../../src/common/validator.js');
const { VALID_CREATE_TX_PARAMS } = require('../../../../../src/common/validator/constants.js');
const { ParamTypeError } = require('../../../../../src/build/errors');
const { spec } = require('../../../../../docs/openrpc.build.js');

const BASE = { data: 'SEND', pubkey: '02ab' };

describe('Encoder input validator', function () {
    describe('validateAll unknown top-level params', function () {
        it('refuses each misspelled money-path setting and names the key', function () {
            for (const key of ['unconfirmd', 'feePerKB', 'RBF', 'compressedPubkey', 'source']) {
                assert.throws(() => v.validateAll({ ...BASE, [key]: false }), (err) => {
                    assert.ok(err instanceof ParamTypeError, `${key}: ${err && err.constructor.name}`);
                    assert.match(err.message, new RegExp(`Unknown create_tx param: "${key}"`));
                    return true;
                });
            }
        });

        it('reports the unknown key ahead of any other field error', function () {
            assert.throws(() => v.validateAll({ ...BASE, fee: 'not-a-number', unconfirmd: false }),
                /Unknown create_tx param: "unconfirmd"/);
        });

        it('still accepts every documented param, null values included', function () {
            const nulled = {};
            for (const key of VALID_CREATE_TX_PARAMS) nulled[key] = null;
            const result = v.validateAll({ ...nulled, data: 'SEND', pubkey: '02ab' });
            assert.strictEqual(result.pubkey, '02ab');
            assert.strictEqual(result.unconfirmed, undefined);
        });

        it('keeps the allow-list equal to the published create_tx params', function () {
            const createTx = spec.methods.find((m) => m.name === 'create_tx');
            const declared = createTx.params.map((p) => p.name).sort();
            assert.ok(declared.length > 10, `extraction too small: ${declared.length}`);
            assert.deepStrictEqual([...VALID_CREATE_TX_PARAMS].sort(), declared);
        });
    });
});
