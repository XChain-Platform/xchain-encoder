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
const bitcoin = require('bitcoinjs-lib');

describe('Encoder input validator', function () {

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
        // Explicit encoding:"OP_RETURN" gets the tighter 76-byte ceiling
        // pre-compile, so an oversize request is rejected as invalid-params before
        // any UTXO reservation instead of failing post-compile as -32603 internal.
        it('rejects an explicit OP_RETURN payload above the 76-byte ceiling', function () {
            // 200 raw bytes compile to 200 + 2 (OP_PUSHDATA1) = 202 > 76.
            const data = 'x'.repeat(200);
            assert.throws(() => v.validateCombinedDataLength(data, null, 'OP_RETURN'),
                /OP_RETURN encoding requires compiled payload <= 76 bytes/);
        });
        it('accepts an explicit OP_RETURN payload at/under the 76-byte ceiling', function () {
            // 75 raw bytes compile to 75 + 1 (direct push) = 76 == ceiling.
            assert.doesNotThrow(() => v.validateCombinedDataLength('x'.repeat(75), null, 'OP_RETURN'));
        });
        it('does NOT apply the OP_RETURN ceiling when encoding is omitted (P2SH auto-fallback)', function () {
            // Same 200-byte payload passes when no explicit encoding is given, so
            // prepareData can auto-select P2SH for the larger payload.
            assert.doesNotThrow(() => v.validateCombinedDataLength('x'.repeat(200), null));
            assert.doesNotThrow(() => v.validateCombinedDataLength('x'.repeat(200), null, undefined));
        });

    });
});

describe('Encoder input validator', function () {
    describe('validateCombinedDataLength', function () {
        // An AUTO request can resolve to TAPROOT in selectEncoding, so the
        // pre-flight check must use the envelope ceiling for it; measuring AUTO
        // against the 8,192-byte legacy ceiling rejected payloads the builder
        // would have accepted. An OMITTED encoding is a different request and
        // keeps the legacy ceiling.
        it('applies the envelope ceiling to AUTO, like TAPROOT', function () {
            const big = 'x'.repeat(50000);
            assert.doesNotThrow(() => v.validateCombinedDataLength(big, null, 'TAPROOT'));
            assert.doesNotThrow(() => v.validateCombinedDataLength(big, null, 'AUTO'));
            assert.throws(() => v.validateCombinedDataLength(big, null), RangeError);
            assert.throws(() => v.validateCombinedDataLength(big, null, 'P2WSH'), RangeError);
            // The envelope ceiling still binds for AUTO.
            assert.throws(() => v.validateCombinedDataLength('x'.repeat(400000), null, 'AUTO'),
                /exceeds maximum \(390000, the TAPROOT envelope payload ceiling\)/);
        });

        // bitcoin.script.compile frames a push of >= 65,536 bytes with
        // OP_PUSHDATA4 (+5), a band compiledPushSize does not model because it is
        // pinned byte-for-byte against the decoder's copy. Only the envelope
        // ceiling reaches that band, and _buildTransaction refuses on the REAL
        // compiled buffer, so under-counting here by 2 per large push moved the
        // boundary payload from this -32602 pre-check to a -32603 builder error.
        it('counts the OP_PUSHDATA4 band on a push past 65,535 bytes', function () {
            // The widest rawData whose real compiled size is exactly the ceiling:
            // OP_0 (1 byte, the empty data push) + rawLen + 5.
            const atCeiling = v.ENVELOPE_MAX_PAYLOAD - 1 - 5;
            assert.strictEqual(
                bitcoin.script.compile([Buffer.alloc(0), Buffer.alloc(atCeiling)]).length,
                v.ENVELOPE_MAX_PAYLOAD,
                'the fixture must sit exactly on the ceiling or the boundary is untested');
            assert.doesNotThrow(() => v.validateCombinedDataLength(null, 'y'.repeat(atCeiling), 'TAPROOT'));
            // One byte more is one byte over, and must be refused HERE rather
            // than surviving to _buildTransaction.
            assert.strictEqual(
                bitcoin.script.compile([Buffer.alloc(0), Buffer.alloc(atCeiling + 1)]).length,
                v.ENVELOPE_MAX_PAYLOAD + 1);
            assert.throws(() => v.validateCombinedDataLength(null, 'y'.repeat(atCeiling + 1), 'TAPROOT'),
                RangeError);
        });

        it('leaves the OP_PUSHDATA2 band alone at its upper edge', function () {
            // 65,535 is still +3, so the correction must not start a byte early,
            // and compiledPushSize itself must stay unforked for the decoder pin.
            assert.strictEqual(bitcoin.script.compile([Buffer.alloc(65535)]).length, 65538);
            assert.strictEqual(v.compiledPushSize(65535), 65538);
            assert.strictEqual(v.compiledPushSize(65536), 65539);
            assert.strictEqual(bitcoin.script.compile([Buffer.alloc(65536)]).length, 65541);
        });

        it('measures rawData-only payloads (data defaults to an OP_0 push)', function () {
            // createTransaction compiles [emptyBuffer, rawDataBuffer]: OP_0 (1 byte)
            // + rawLen + 3 (OP_PUSHDATA2). 8188 -> 8192 == ceiling; 8189 -> 8193.
            assert.doesNotThrow(() => v.validateCombinedDataLength(null, 'y'.repeat(8188)));
            assert.throws(() => v.validateCombinedDataLength(null, 'y'.repeat(8189)), RangeError);
        });
    });
});
