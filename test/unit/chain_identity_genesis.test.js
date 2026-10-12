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
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    chainGenesisMismatch,
    chainGenesisUnpinned,
} = require('../../src/build/blockchain_connector/chain_identity.js');

const BTC_MAINNET = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const DOGE_MAINNET = '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691';
const TESTNET3 = '3'.repeat(64);
const TESTNET4 = '4'.repeat(64);

describe('chain identity genesis helpers', function () {
    it('catches a same-tier cross-coin pairing', function () {
        const reason = chainGenesisMismatch(BTC_MAINNET, DOGE_MAINNET);
        assert.ok(reason);
        assert.ok(reason.includes(BTC_MAINNET));
        assert.ok(reason.includes(DOGE_MAINNET));
    });

    it('catches a testnet3 versus testnet4 pairing', function () {
        const reason = chainGenesisMismatch(TESTNET3, TESTNET4);
        assert.ok(reason);
        assert.ok(reason.includes(TESTNET3));
        assert.ok(reason.includes(TESTNET4));
    });

    it('accepts an agreeing hash regardless of case', function () {
        assert.strictEqual(chainGenesisMismatch(BTC_MAINNET, BTC_MAINNET), null);
        assert.strictEqual(chainGenesisMismatch(BTC_MAINNET.toUpperCase(), BTC_MAINNET), null);
        assert.strictEqual(chainGenesisMismatch(BTC_MAINNET, BTC_MAINNET.toUpperCase()), null);
    });

    it('fails open when no usable hash is pinned', function () {
        assert.strictEqual(chainGenesisMismatch(null, DOGE_MAINNET), null);
        assert.strictEqual(chainGenesisMismatch(undefined, DOGE_MAINNET), null);
        assert.strictEqual(chainGenesisMismatch('', DOGE_MAINNET), null);
        assert.strictEqual(chainGenesisMismatch(42, DOGE_MAINNET), null);
    });

    it('fails open when the node reports no usable hash', function () {
        assert.strictEqual(chainGenesisMismatch(BTC_MAINNET, null), null);
        assert.strictEqual(chainGenesisMismatch(BTC_MAINNET, undefined), null);
        assert.strictEqual(chainGenesisMismatch(BTC_MAINNET, ''), null);
        assert.strictEqual(chainGenesisMismatch(BTC_MAINNET, 42), null);
    });

    it('reports whether the genesis pin is absent', function () {
        assert.strictEqual(chainGenesisUnpinned(null), true);
        assert.strictEqual(chainGenesisUnpinned(undefined), true);
        assert.strictEqual(chainGenesisUnpinned(''), true);
        assert.strictEqual(chainGenesisUnpinned(42), true);
        assert.strictEqual(chainGenesisUnpinned(BTC_MAINNET), false);
    });
});
