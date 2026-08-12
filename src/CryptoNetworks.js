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
 * XChain Encoder - Crypto Networks Class
 *
 * Thin adapter over the canonical coin registry (src/coins). The bitcoinjs
 * network object and the indexing start height now come from the single source
 * of truth instead of an in-file switch. The legacy getFirstBlock TODO ("this
 * config data should come from xchain-hub") is resolved: the canonical files are
 * the hub-authored source, vendored into each service.
 *
 ********************************************************************/

const coins = require('./coins');

const SUPPORTED = 'bitcoin-mainnet, bitcoin-testnet, bitcoin-regtest, dogecoin-mainnet, ' +
    'dogecoin-testnet, dogecoin-regtest, litecoin-mainnet, litecoin-testnet, litecoin-regtest';

// Split a "<fullname>-<network>" key (e.g. "bitcoin-mainnet") into a canonical
// {tick, net} pair, or null when it names no known coin/network.
function parseNetworkName(networkName){
    const s = String(networkName);
    const i = s.lastIndexOf('-');
    if(i < 0) return null;
    const tick = coins.FULL_NAME_TO_TICK[s.slice(0, i)];
    const net  = s.slice(i + 1);
    if(!tick || !coins.NETWORKS.includes(net)) return null;
    return { tick, net };
}

class CryptoNetworks {
    // bitcoinjs-lib network object (+ XChain relay overlays) for a network key.
    static getBitcoinJsNetwork(networkName){
        const p = parseNetworkName(networkName);
        if(!p) throw new TypeError(`Unknown network: "${networkName}". Supported: ${SUPPORTED}`);
        return coins.getCoinConfig(p.tick, p.net).net;
    }

    // Indexing start height (not part of any consensus hash). Unknown/regtest -> 0.
    static getFirstBlock(networkName){
        const p = parseNetworkName(networkName);
        return p ? coins.getCoinConfig(p.tick, p.net).firstBlock : 0;
    }

    // The LOCAL block height at/above which decoders recognize
    // Taproot-envelope reveals as action-bearing. Unlike firstBlock this IS
    // consensus-visible: it is the flag height the whole fleet flips at, so this
    // copy is vendored byte-equal from the canonical
    // xchain-documentation/protocol/constants.js (and xchain-decoder's copy of it),
    // and a unit test fails if it ever drifts.
    //
    // The encoder needs it because building an envelope below the height produces a
    // valid, broadcastable, correctly signed pair that every decoder ignores: the
    // caller pays a real fee for an action that never exists. DOGE is null forever
    // (no segwit, hence no Taproot).
    //
    // Returns undefined for an unparseable network name, which the caller must treat
    // as "cannot confirm" and refuse, never as "allowed".
    static getEnvelopeRecognitionHeight(networkName){
        const p = parseNetworkName(networkName);
        if(!p) return undefined;
        const row = ENVELOPE_RECOGNITION_ACTIVATION[p.tick];
        return row ? row[p.net] : undefined;
    }
}

// Vendored byte-equal from xchain-documentation/protocol/constants.js.
// MAINNET HEIGHTS PULLED IN 2026-08-02 (operator decision): BTC 961000 ->
// 960850, LTC 3160000 -> 3153500, both ~6 hours out from a measured tip rather
// than 2 and 12 days. Pre-launch features do not wait on dates; the fleet
// already runs this code, so only the constant moves.
const ENVELOPE_RECOGNITION_ACTIVATION = {
    BTC:  { mainnet: 960850, testnet: 0, regtest: 0 },
    LTC:  { mainnet: 3153500, testnet: 0, regtest: 0 },
    DOGE: { mainnet: null, testnet: null, regtest: null },
};

CryptoNetworks.ENVELOPE_RECOGNITION_ACTIVATION = ENVELOPE_RECOGNITION_ACTIVATION;

module.exports = CryptoNetworks;
