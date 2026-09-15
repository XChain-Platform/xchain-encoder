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

    describe('alias expansion at the compiled ceiling', function () {
        // MAX_COMPILED_ACTION_DATA_LENGTH bounds the COMPILED on-chain push - i.e.
        // the alias/wire spelling - measured BEFORE the decoder canonicalizes the
        // name. Several aliases EXPAND during that canonicalization (ADDR->ADDRESS
        // +3, DROP->AIRDROP +3, MSG->MESSAGE +4, CAST->BROADCAST +5), and nothing
        // re-measures afterward, so a CAST payload accepted right at the ceiling is
        // stored as a BROADCAST record a few bytes past the numeric cap. That is
        // intentional: the cap is a wire-bytes cap, not a stored-record cap. This
        // pins the boundary on the encoder half; the decoder half is pinned by
        // xchain-decoder/test/unit/alias_expansion_boundary.test.js.
        const PREFIX = 'CAST|0|';
        // MAX_DATA_BYTES == MAX_COMPILED_ACTION_DATA_LENGTH - OP_PUSHDATA2 overhead:
        // the widest single raw push whose compiled form is exactly the ceiling.
        const atCeiling = PREFIX + 'a'.repeat(v.MAX_DATA_BYTES - PREFIX.length);
        const overCeiling = PREFIX + 'a'.repeat(v.MAX_DATA_BYTES + 1 - PREFIX.length);

        it('the at-ceiling CAST push measures exactly the cap', function () {
            assert.strictEqual(atCeiling.length, v.MAX_DATA_BYTES);
            assert.strictEqual(v.compiledPushSize(atCeiling.length), v.MAX_COMPILED_ACTION_DATA_LENGTH);
        });

        it('accepts the CAST payload sitting exactly at the compiled ceiling', function () {
            assert.doesNotThrow(() => v.validateCombinedDataLength(atCeiling, null));
            // The size gate is the ONLY gate that fires here: the ACTION-name gate
            // accepts CAST because it resolves to the canonical BROADCAST.
            assert.doesNotThrow(() => v.validateActionName(atCeiling));
            assert.strictEqual(v.ACTION_ALIASES['CAST'], 'BROADCAST');
        });

        it('rejects the CAST payload one byte over the ceiling with a RangeError', function () {
            // RangeError is what api.js maps to a JSON-RPC -32602 invalid-params.
            assert.strictEqual(v.compiledPushSize(overCeiling.length), v.MAX_COMPILED_ACTION_DATA_LENGTH + 1);
            assert.throws(() => v.validateCombinedDataLength(overCeiling, null), RangeError);
        });

        it('the accepted at-ceiling CAST is stored as a record past the cap', function () {
            // CAST -> BROADCAST adds 5 bytes to the leading name and nothing
            // re-measures, so the stored ACTION record exceeds the numeric cap.
            const grow = 'BROADCAST'.length - 'CAST'.length;
            const storedLen = atCeiling.length + grow;
            assert.strictEqual(grow, 5);
            assert.strictEqual(storedLen, v.MAX_DATA_BYTES + 5);
            assert.ok(storedLen > v.MAX_COMPILED_ACTION_DATA_LENGTH,
                'the stored record is intentionally allowed a few bytes past the wire cap');
        });
    });
});
