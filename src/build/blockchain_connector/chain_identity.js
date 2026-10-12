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
 * The pure identity decisions from xchain-decoder's
 * src/protocol/chain_identity.js, kept in step with it. The reported chain
 * proves tier identity, while the block-0 hash proves coin and chain identity.
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

// Return a reason string when two usable block-0 hashes differ, else null.
function chainGenesisMismatch(pinnedHash, reportedHash){
    if (typeof pinnedHash !== 'string' || pinnedHash === '') return null;
    if (typeof reportedHash !== 'string' || reportedHash === '') return null;
    if (pinnedHash.toLowerCase() === reportedHash.toLowerCase()) return null;
    return 'node block-0 hash is ' + reportedHash + ', but this encoder is pinned to ' +
        pinnedHash + ', so the endpoint is serving a different chain';
}

// Return true when no usable block-0 hash is pinned.
function chainGenesisUnpinned(pinnedHash){
    return typeof pinnedHash !== 'string' || pinnedHash === '';
}

module.exports = {
    CHAIN_TO_NETWORK,
    chainTierMismatch,
    chainGenesisMismatch,
    chainGenesisUnpinned,
};
