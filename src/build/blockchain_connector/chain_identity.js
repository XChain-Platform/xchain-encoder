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
 *
 * XChain Encoder - coin-node chain-tier identity
 *
 * The tier half of xchain-decoder's src/protocol/chain_identity.js, kept in
 * step with it. getblockchaininfo's `chain` names the network TIER, never the
 * coin, and `test`/`testnet3`/`testnet4` collapse to one tier, so this can
 * prove "wrong tier" and nothing more.
 *
 ********************************************************************/

'use strict';

// getblockchaininfo chain strings mapped to the encoder's consensus network name.
const CHAIN_TO_NETWORK = {
    main:     'mainnet',
    test:     'testnet',
    testnet3: 'testnet',
    testnet4: 'testnet',
    regtest:  'regtest',
    signet:   'signet',
};

// Return a reason string when reportedChain is a recognized tier other than consensusNetwork, else null.
// (Fails open on an absent or unknown chain string, as the decoder does.)
function chainTierMismatch(consensusNetwork, reportedChain){
    if (typeof reportedChain !== 'string' || reportedChain === '') return null;
    const mapped = CHAIN_TO_NETWORK[reportedChain];
    if (!mapped) return null;
    if (mapped === String(consensusNetwork)) return null;
    return 'node reports chain="' + reportedChain + '" (' + mapped +
        ') but this encoder is configured for ' + consensusNetwork;
}

module.exports = { CHAIN_TO_NETWORK, chainTierMismatch };
