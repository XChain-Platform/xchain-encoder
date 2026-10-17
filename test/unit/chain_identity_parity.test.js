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
const path = require('path');

const { CHAIN_TO_NETWORK } = require('../../src/build/blockchain_connector/chain_identity');
const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout');

const DECODER_DIR = process.env.XCHAIN_DECODER_DIR || path.join(__dirname, '../../../xchain-decoder');
const DECODER_IDENTITY = path.join(DECODER_DIR, 'src', 'protocol', 'chain_identity.js');

describe('chain identity map parity with xchain-decoder', function(){
    let decoderChainToNetwork;

    before(function(){
        const decoder = siblingCheckout(__dirname, DECODER_IDENTITY);
        if(!decoder.usable)
            return skipOrFail(this, decoder, 'the encoder/decoder chain identity parity guard');
        ({ CHAIN_TO_NETWORK: decoderChainToNetwork } = require(DECODER_IDENTITY));
    });

    it('matches every decoder chain key and network value', function(){
        assert.deepStrictEqual(CHAIN_TO_NETWORK, decoderChainToNetwork);
    });
});
