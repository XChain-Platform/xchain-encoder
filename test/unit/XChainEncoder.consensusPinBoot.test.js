'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Boot guard: the encoder vendors the consensus-critical coin registry and reads
// dustThreshold / supportsSegwit / address prefixes out of it, so it must run the
// same fail-closed pin check every sibling consumer runs (decoder, indexer, hub,
// utxo-tracker). coins-conformance.test.js catches commit-time drift only; it
// cannot catch a stale deployed image, which is what this guard is for.

const assert = require('assert');

const coins        = require('../../src/coins');
const XChainEncoder = require('../../src/XChainEncoder');

describe('XChainEncoder consensus-pin boot guard', function(){
    let original;

    beforeEach(function(){ original = coins.verifyConsensusPin; });
    afterEach(function(){ coins.verifyConsensusPin = original; });

    function build(){
        return new XChainEncoder('bitcoin-regtest', 'http://127.0.0.1', 18443, 'u', 'p', 'http://127.0.0.1', 4000);
    }

    it('verifies the vendored bundle at construction, with the net portion of the network key', function(){
        let seen = [];
        coins.verifyConsensusPin = function(net){ seen.push(net); return { ok: true, skipped: false }; };
        build();
        assert.deepStrictEqual(seen, ['regtest']);
    });

    it('fails closed: a pin mismatch aborts construction rather than authoring under a drifted bundle', function(){
        coins.verifyConsensusPin = function(){ throw new Error('CONSENSUS CONFIG PIN MISMATCH for BTC/regtest'); };
        assert.throws(build, /CONSENSUS CONFIG PIN MISMATCH/);
    });

    it('the real check passes for the bundle actually vendored here', function(){
        assert.doesNotThrow(build);
    });
});
