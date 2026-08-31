/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/suggestedFeeCeiling.test.js
 *
 * The suggested-rate ceiling for a caller that supplies no fee.
 *
 * estimatesmartfee needs a populated fee market to mean anything. A quiet test
 * chain returns a large fallback at every confirmation target, which prices an
 * ordinary action far above the balance funding it and fails the build before
 * anything is signed. Mainnet must stay unclamped, because there the estimate is
 * real and a ceiling would underpay a genuine spike.
 */

'use strict';

const assert         = require('assert');
const XChainEncoder  = require('../../src/XChainEncoder');

const SATOSHI_UNIT = 100000000;
const ceiling      = (net) => XChainEncoder.suggestedFeeCeilingPerByte(net, SATOSHI_UNIT);
const perVbyte     = (btcPerByte) => btcPerByte == null ? null : Math.round(btcPerByte * SATOSHI_UNIT);

afterEach(function () { delete process.env.SUGGESTED_FEE_MAX_PER_VBYTE; });

describe('suggested fee-rate ceiling @regression @tier1', function () {

    it('clamps test chains to the default ceiling', function () {
        for (const net of ['bitcoin-testnet', 'litecoin-testnet', 'dogecoin-testnet', 'bitcoin-regtest']) {
            assert.strictEqual(perVbyte(ceiling(net)),
                XChainEncoder.DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE, net + ' must be clamped');
        }
    });

    // The 20/vByte default is Bitcoin-scale. On Dogecoin the node's relay floor
    // is 100 koinu/byte and 1.14's priority gate rejects anything at or under it,
    // so the clamp must never sit below ten times the node's own relayfee.
    it('raises the ceiling to 10x the node relay floor when the default is below it (DOGE)', function () {
        const floor = XChainEncoder.suggestedFeeCeilingFloorPerByte(0.001);   // DOGE relayfee, DOGE/kB
        assert.strictEqual(perVbyte(floor), 1000, '0.001 DOGE/kB x10 is 1000 koinu/byte');
        assert.ok(floor > ceiling('dogecoin-testnet'), 'the relay-derived floor must exceed the 20/vByte default');
    });

    it('leaves the default ceiling in charge when the relay floor is below it (BTC/LTC)', function () {
        const floor = XChainEncoder.suggestedFeeCeilingFloorPerByte(0.00001);  // BTC/LTC relayfee
        assert.strictEqual(perVbyte(floor), 10);
        assert.ok(floor < ceiling('bitcoin-testnet'));
    });

    // A ceiling equal to the node rate is the ordinary DOGE test-chain case: both
    // sides are ten times relayfee, and float division leaves them one ULP apart.
    // Clamping there reassigns the same number and logs a breach that did not happen.
    it('treats a ceiling equal to the node rate as NOT a breach', function () {
        const nodeRate = 0.01 / 1000;                                   // DOGE/byte
        const cap      = XChainEncoder.suggestedFeeCeilingFloorPerByte(0.001);
        assert.ok(Math.abs(nodeRate - cap) < nodeRate * 1e-9, 'the two must be equal to within float noise');
        assert.ok(!(nodeRate > cap * (1 + 1e-12)), 'an equal rate must not read as exceeding the ceiling');
    });

    it('returns null for a missing or non-positive relayfee', function () {
        assert.strictEqual(XChainEncoder.suggestedFeeCeilingFloorPerByte(undefined), null);
        assert.strictEqual(XChainEncoder.suggestedFeeCeilingFloorPerByte(0), null);
        assert.strictEqual(XChainEncoder.suggestedFeeCeilingFloorPerByte(-1), null);
    });

    it('leaves mainnet UNCLAMPED, where the estimate is real', function () {
        for (const net of ['bitcoin-mainnet', 'litecoin-mainnet', 'dogecoin-mainnet']) {
            assert.strictEqual(ceiling(net), null, net + ' must not be clamped');
        }
    });

    it('treats an unknown or empty network as mainnet, never as a test chain', function () {
        // Fail toward the unclamped side: wrongly clamping a real fee market
        // underpays and strands a transaction, which is worse than a high quote.
        assert.strictEqual(ceiling(''), null);
        assert.strictEqual(ceiling(undefined), null);
        assert.strictEqual(ceiling('bitcoin-somethingelse'), null);
    });

    it('SUGGESTED_FEE_MAX_PER_VBYTE overrides the default, on any chain', function () {
        process.env.SUGGESTED_FEE_MAX_PER_VBYTE = '7';
        assert.strictEqual(perVbyte(ceiling('bitcoin-testnet')), 7);
        assert.strictEqual(perVbyte(ceiling('bitcoin-mainnet')), 7, 'an explicit operator ceiling applies to mainnet too');
    });

    it('SUGGESTED_FEE_MAX_PER_VBYTE=0 disables the clamp', function () {
        process.env.SUGGESTED_FEE_MAX_PER_VBYTE = '0';
        assert.strictEqual(ceiling('bitcoin-testnet'), null);
    });

    it('ignores an unparseable override rather than clamping to NaN', function () {
        process.env.SUGGESTED_FEE_MAX_PER_VBYTE = 'not-a-number';
        assert.strictEqual(perVbyte(ceiling('bitcoin-testnet')),
            XChainEncoder.DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE);
    });

    it('prices the real failure inside the balance that funded it', function () {
        // The measured case: a 260 vByte action, an owner holding 15,916 base
        // units, and a node quoting 376 per vByte at every tier.
        const vsize = 260;
        const nodeRate = 376 / SATOSHI_UNIT;
        const capped = Math.min(nodeRate, ceiling('bitcoin-testnet'));
        assert.ok(Math.round(vsize * nodeRate * SATOSHI_UNIT) > 15916, 'the node rate must exceed the balance');
        assert.ok(Math.round(vsize * capped * SATOSHI_UNIT) < 15916, 'the clamped rate must fit inside it');
    });

    it('identifies test networks by suffix', function () {
        assert.strictEqual(XChainEncoder.isTestNetworkKey('bitcoin-testnet'), true);
        assert.strictEqual(XChainEncoder.isTestNetworkKey('BITCOIN-REGTEST'), true);
        assert.strictEqual(XChainEncoder.isTestNetworkKey('bitcoin-mainnet'), false);
    });
});
