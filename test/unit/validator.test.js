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
 * Unit tests for src/validator.js: centralized createTransaction input
 * validation. Every validator returns the coerced value or throws
 * TypeError/RangeError. validateCustomOutput / validateFeeQuote are exercised
 * through their array/validateAll wrappers (not individually exported).
 ********************************************************************/

const assert = require('assert');
const v = require('../../src/validator.js');

const HEX64 = 'a'.repeat(64);

describe('Encoder input validator', function () {

    describe('validatePubkey', function () {
        it('passes null/valid through, throws on bad input', function () {
            assert.strictEqual(v.validatePubkey(null), null);
            assert.strictEqual(v.validatePubkey(undefined), null);
            assert.strictEqual(v.validatePubkey('02abcd'), '02abcd');
            assert.throws(() => v.validatePubkey(''), TypeError);
            assert.throws(() => v.validatePubkey(123), TypeError);
            assert.throws(() => v.validatePubkey('x'.repeat(201)), /maximum length/);
        });
    });

    describe('validateDataParam', function () {
        it('null passes, string passes, non-string throws with field name', function () {
            assert.strictEqual(v.validateDataParam(null, 'data'), null);
            assert.strictEqual(v.validateDataParam('hello', 'data'), 'hello');
            assert.throws(() => v.validateDataParam(5, 'rawData'), /rawData must be a string/);
        });
    });

    describe('validateActionName (: encoder ACTION-name gate)', function () {
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

    describe('validateCombinedDataLength', function () {
        it('returns early for null data and accepts within-limit payloads', function () {
            assert.strictEqual(v.validateCombinedDataLength(null, null), undefined);
            assert.doesNotThrow(() => v.validateCombinedDataLength('abc', null));
            assert.doesNotThrow(() => v.validateCombinedDataLength('abc', 'rawbytes'));
        });
        it('counts data + rawData and throws over the limit', function () {
            const big = 'x'.repeat(v.MAX_DATA_BYTES);
            assert.doesNotThrow(() => v.validateCombinedDataLength(big, null));
            assert.throws(() => v.validateCombinedDataLength(big, 'y'), RangeError);
        });
        it('accepts a single-push payload at the compiled ceiling (backwards-compatible)', function () {
            // 8189 raw bytes compile to 8189 + 3 (OP_PUSHDATA2) == 8192 == ceiling.
            const single = 'x'.repeat(v.MAX_DATA_BYTES);
            assert.doesNotThrow(() => v.validateCombinedDataLength(single, null));
        });
        it('accounts for per-push overhead on dual-push payloads at the boundary', function () {
            // Two pushes of 4093 bytes each compile to (4093 + 3) * 2 == 8192 == ceiling.
            const okData = 'x'.repeat(4093);
            const okRaw = 'y'.repeat(4093);
            assert.doesNotThrow(() => v.validateCombinedDataLength(okData, okRaw));
        });
        it('rejects dual-push payloads whose compiled size exceeds the ceiling', function () {
            // Two pushes of 4094 bytes each compile to (4094 + 3) * 2 == 8194 > 8192.
            const bigData = 'x'.repeat(4094);
            const bigRaw = 'y'.repeat(4094);
            assert.throws(() => v.validateCombinedDataLength(bigData, bigRaw), RangeError);
        });
        it('rejects the documented dual-push undercount case (raw sum within old limit)', function () {
            // 4094 + 4095 == 8189 raw bytes passed the old sum-based check, but the
            // two pushes compile to 4097 + 4098 == 8195 > 8192.
            const data = 'x'.repeat(4094);
            const rawData = 'y'.repeat(4095);
            assert.throws(() => v.validateCombinedDataLength(data, rawData), RangeError);
        });
        it('measures rawData-only payloads (data defaults to an OP_0 push)', function () {
            // createTransaction compiles [emptyBuffer, rawDataBuffer]: OP_0 (1 byte)
            // + rawLen + 3 (OP_PUSHDATA2). 8188 -> 8192 == ceiling; 8189 -> 8193.
            assert.doesNotThrow(() => v.validateCombinedDataLength(null, 'y'.repeat(8188)));
            assert.throws(() => v.validateCombinedDataLength(null, 'y'.repeat(8189)), RangeError);
        });
    });

    describe('validateEncoding', function () {
        it('accepts the valid set, null passes, unknown throws', function () {
            for (const e of v.VALID_ENCODINGS) assert.strictEqual(v.validateEncoding(e), e);
            assert.strictEqual(v.validateEncoding(null), null);
            assert.throws(() => v.validateEncoding('BOGUS'), /Invalid encoding/);
            assert.throws(() => v.validateEncoding(7), /Invalid encoding/);
        });
    });

    describe('validateFee', function () {
        it('null/false pass; coerces; rejects NaN, negative, over-max', function () {
            assert.strictEqual(v.validateFee(null), null);
            assert.strictEqual(v.validateFee(false), null);
            assert.strictEqual(v.validateFee('1000'), 1000);
            assert.throws(() => v.validateFee('abc'), TypeError);
            assert.throws(() => v.validateFee({}), /got: object/);
            assert.throws(() => v.validateFee(-1), RangeError);
            assert.throws(() => v.validateFee(v.MAX_FEE_SATOSHIS + 1), /exceeds maximum/);
        });
    });

    describe('validateFeePerKb', function () {
        it('null/false pass; rejects non-finite and non-positive', function () {
            assert.strictEqual(v.validateFeePerKb(null), null);
            assert.strictEqual(v.validateFeePerKb(false), null);
            assert.strictEqual(v.validateFeePerKb('2.5'), 2.5);
            assert.throws(() => v.validateFeePerKb('nope'), TypeError);
            assert.throws(() => v.validateFeePerKb(Infinity), TypeError);
            assert.throws(() => v.validateFeePerKb(0), RangeError);
            assert.throws(() => v.validateFeePerKb(-3), RangeError);
        });
        it('rejects hex, scientific, boolean, array, and object forms Number() would coerce', function () {
            assert.throws(() => v.validateFeePerKb('0x20'), TypeError);   // hex string -> 32
            assert.throws(() => v.validateFeePerKb('1e3'), TypeError);    // scientific -> 1000
            assert.throws(() => v.validateFeePerKb(true), TypeError);     // boolean -> 1
            assert.throws(() => v.validateFeePerKb([50]), TypeError);     // array -> 50
            assert.throws(() => v.validateFeePerKb({}), TypeError);       // object -> NaN
        });
    });

    describe('validateDust', function () {
        it('null/false pass; coerces; rejects NaN and negative', function () {
            assert.strictEqual(v.validateDust(null), null);
            assert.strictEqual(v.validateDust(false), null);
            assert.strictEqual(v.validateDust('546'), 546);
            assert.throws(() => v.validateDust('xx'), TypeError);
            assert.throws(() => v.validateDust(-5), RangeError);
        });
    });

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

        it('rejects vout values bare Number() would coerce to a plausible index (uuid:4555d78c)', function () {
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

    describe('validateP2shParams', function () {
        it('both-omitted yields nulls; mismatch throws', function () {
            assert.deepStrictEqual(v.validateP2shParams(null, false), { p2shHash: null, p2shHex: null });
            assert.throws(() => v.validateP2shParams(HEX64, null), /both be provided or both omitted/);
        });
        it('validates hash hex and non-empty hex; returns the pair', function () {
            assert.throws(() => v.validateP2shParams('bad', 'deadbeef'), /64-character hex/);
            assert.throws(() => v.validateP2shParams(HEX64, ''), /non-empty hex/);
            assert.deepStrictEqual(v.validateP2shParams(HEX64, 'deadbeef'), { p2shHash: HEX64, p2shHex: 'deadbeef' });
        });
        it('enforces hex shape and the raw-tx length cap on p2shHex', function () {
            assert.throws(() => v.validateP2shParams(HEX64, 'not-hex!'), /even-length hex/);
            assert.throws(() => v.validateP2shParams(HEX64, 'abc'), /even-length hex/);
            assert.throws(
                () => v.validateP2shParams(HEX64, 'ab'.repeat(v.MAX_RAW_TX_HEX_LENGTH / 2 + 1)),
                /exceeds maximum length/
            );
            // Exactly at the cap is accepted (shape-valid hex)
            const atCap = 'ab'.repeat(v.MAX_RAW_TX_HEX_LENGTH / 2);
            assert.strictEqual(v.validateP2shParams(HEX64, atCap).p2shHex, atCap);
        });
    });

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
        it('rejects hex above MAX_RAW_TX_HEX_LENGTH', function () {
            assert.throws(
                () => v.validateRawTxHex('ab'.repeat(v.MAX_RAW_TX_HEX_LENGTH / 2 + 1)),
                /exceeds maximum length/
            );
        });
    });

    describe('validateCompressedPubKey', function () {
        it('null passes; enforces the 02/03 + 64-hex shape', function () {
            assert.strictEqual(v.validateCompressedPubKey(null), null);
            assert.strictEqual(v.validateCompressedPubKey('02' + HEX64), '02' + HEX64);
            assert.throws(() => v.validateCompressedPubKey('04' + HEX64), /02 or 03/);
            assert.throws(() => v.validateCompressedPubKey('nope'), TypeError);
        });
    });

    describe('validateChange', function () {
        it('null passes; rejects empty and over-long', function () {
            assert.strictEqual(v.validateChange(null), null);
            assert.strictEqual(v.validateChange('addr'), 'addr');
            assert.throws(() => v.validateChange(''), /non-empty/);
            assert.throws(() => v.validateChange('x'.repeat(101)), /maximum length/);
        });
    });

    describe('validateAddress', function () {
        it('accepts a valid string (incl. exactly 100 chars); rejects empty, non-string, and over-length', function () {
            assert.strictEqual(v.validateAddress('addr'), 'addr');
            assert.strictEqual(v.validateAddress('x'.repeat(100)), 'x'.repeat(100));
            assert.throws(() => v.validateAddress(''), /non-empty string/);
            assert.throws(() => v.validateAddress({}), /non-empty string/);
            assert.throws(() => v.validateAddress([]), /non-empty string/);
            assert.throws(() => v.validateAddress(123), /non-empty string/);
            assert.throws(() => v.validateAddress(null), /non-empty string/);
            assert.throws(() => v.validateAddress('x'.repeat(101)), /maximum length/);
        });
    });

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

        it('exercises validateFeeQuote validation paths through validateAll', function () {
            const base = { data: 'SEND', pubkey: '02ab' };
            assert.throws(() => v.validateAll({ ...base, feeQuote: 'no' }), /feeQuote must be an object/);
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
