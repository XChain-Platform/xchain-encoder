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

    describe('validateAll', function () {
        it('throws when params is not an object', function () {
            assert.throws(() => v.validateAll(null), /must be an object/);
            assert.throws(() => v.validateAll('x'), /must be an object/);
        });

        it('returns a fully-coerced, normalized param set', function () {
            const result = v.validateAll({
                data: 'SEND',
                rawData: 'world',
                pubkey: '02ab',
                encoding: 'OP_RETURN',
                fee: '1000',
                feePerKb: '2',
                dust: '546',
                utxos: [{ txid: HEX64, vout: '0', value: '5000', scriptPubKey: 'aa' }],
                customOutputs: [{ address: 'addr', value: '10' }],
                feeQuote: { address: 'fqaddr', amount: '999' },
                p2shHash: HEX64,
                p2shHex: 'deadbeef',
                compressedPubKey: '03' + HEX64,
                change: 'changeaddr',
                rbf: true,
                unconfirmed: false,
            });
            assert.strictEqual(result.fee, 1000);
            assert.strictEqual(result.utxos[0].value, 5000);
            assert.strictEqual(result.customOutputs[0].value, 10);
            assert.strictEqual(result.feeQuote.amount, 999);
            assert.strictEqual(result.rbf, true);
            assert.strictEqual(result.unconfirmed, false);
        });

        it('rejects non-boolean rbf/unconfirmed instead of truthiness-coercing (string "false" must not flip policy to true)', function () {
            const base = { data: 'SEND', pubkey: '02ab' };
            assert.throws(() => v.validateAll({ ...base, unconfirmed: 'false' }), TypeError);
            assert.throws(() => v.validateAll({ ...base, unconfirmed: 'true' }), /unconfirmed must be a boolean/);
            assert.throws(() => v.validateAll({ ...base, rbf: 'false' }), /rbf must be a boolean/);
            assert.throws(() => v.validateAll({ ...base, rbf: 1 }), TypeError);
            assert.throws(() => v.validateAll({ ...base, unconfirmed: 0 }), TypeError);
        });

        it('rbf/unconfirmed absent or null stay undefined so downstream defaults apply', function () {
            const base = { data: 'SEND', pubkey: '02ab' };
            const absent = v.validateAll(base);
            assert.strictEqual(absent.rbf, undefined);
            assert.strictEqual(absent.unconfirmed, undefined);
            const nulled = v.validateAll({ ...base, rbf: null, unconfirmed: null });
            assert.strictEqual(nulled.rbf, undefined);
            assert.strictEqual(nulled.unconfirmed, undefined);
        });

    });
});

describe('Encoder input validator', function () {
    describe('validateAll', function () {
        it('exercises validateFeeQuote validation paths through validateAll', function () {
            const base = { data: 'SEND', pubkey: '02ab' };
            assert.throws(() => v.validateAll({ ...base, feeQuote: 'no' }), /feeQuote must be an object/);
            // An array is typeof 'object'; it must fail the SHAPE check, not the
            // address check one line later.
            assert.throws(() => v.validateAll({ ...base, feeQuote: [] }), /feeQuote must be an object/);
            assert.throws(() => v.validateAll({ ...base, feeQuote: ['1Addr', 1000] }), /feeQuote must be an object/);
            assert.throws(() => v.validateAll({ ...base, feeQuote: { address: '', amount: 1 } }), /address must be a non-empty/);
            assert.throws(() => v.validateAll({ ...base, feeQuote: { address: 'x'.repeat(101), amount: 1 } }), /maximum length/);
            assert.throws(() => v.validateAll({ ...base, feeQuote: { address: 'a', amount: 0 } }), /positive integer/);
            assert.throws(() => v.validateAll({ ...base, feeQuote: { address: 'a', amount: v.MAX_FEE_SATOSHIS + 1 } }), /exceeds maximum/);
            assert.strictEqual(v.validateAll({ ...base, feeQuote: null }).feeQuote, null);
        });

        it('runs the combined-length pre-check on rawData-only requests', function () {
            const result = v.validateAll({ data: null, rawData: 'x'.repeat(100), pubkey: '02ab' });
            assert.strictEqual(result.data, null);
            assert.strictEqual(result.rawData, 'x'.repeat(100));
            // Oversize rawData-only is rejected here (invalid params), not left
            // to createTransaction's compiled-size ceiling (internal error).
            assert.throws(() => v.validateAll({ data: null, rawData: 'x'.repeat(8189), pubkey: '02ab' }), RangeError);
        });

        it('rejects an absent or null pubkey (openrpc marks it required)', function () {
            // pubkey omitted / null must fail up front (RangeError -> -32602) rather
            // than reaching fromBase58Check(null) deep in createTransaction.
            assert.throws(() => v.validateAll({ data: 'SEND' }), /pubkey is required/);
            assert.throws(() => v.validateAll({ data: 'SEND', pubkey: null }), /pubkey is required/);
        });
    });
});
