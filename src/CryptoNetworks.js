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
 * This file handles getting a bitcoinJS config for a specific network
 * 
 ********************************************************************/

// Load required libraries
const bitcoin = require('bitcoinjs-lib');

class CryptoNetworks {
    static getBitcoinJsNetwork(networkName){
        // minStandardTxNonWitnessSize: the minimum stripped (non-witness) byte
        // count a transaction must serialize to before a node will relay it as
        // standard. Bitcoin Core uses 65 (MIN_STANDARD_TX_NONWITNESS_SIZE);
        // Litecoin Core raised it to ~85, so a tx that relays on Bitcoin can be
        // rejected as "tx-size-small" on Litecoin. The P2WSH reveal builder pads
        // its stripped size up to this floor (see XChainEncoder).
        switch(networkName){
            case "bitcoin-mainnet":
                return { ...bitcoin.networks.bitcoin, dustThreshold: 546, minStandardTxNonWitnessSize: 65, singleOpReturnPolicy: true }
            case "bitcoin-testnet":
                return { ...bitcoin.networks.testnet, dustThreshold: 546, minStandardTxNonWitnessSize: 65, singleOpReturnPolicy: true }
            case "bitcoin-regtest":
                return { ...bitcoin.networks.regtest, dustThreshold: 546, minStandardTxNonWitnessSize: 65, singleOpReturnPolicy: true }
            case "dogecoin-mainnet":
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x02facafd,
                       "private": 0x02fac398
                    },
                    "pubKeyHash": 0x1e,
                    "scriptHash": 0x16,
                    "wif": 0x9e,
                    "dustThreshold": 100000,
                    "supportsSegwit": false,
                    // DOGE allows larger/multiple OP_RETURN outputs; no single-output size guard
                    "singleOpReturnPolicy": false
                }
            case "dogecoin-testnet":
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x0432a9a8,
                       "private": 0x0432a243
                    },
                    "pubKeyHash": 0x71,
                    "scriptHash": 0xc4,
                    "wif": 0xf1,
                    "dustThreshold": 100000,
                    "supportsSegwit": false,
                    "singleOpReturnPolicy": false
                }
            case "dogecoin-regtest":
                // Dogecoin v1.14.x regtest reuses Bitcoin-testnet prefixes
                // (pubKeyHash 0x6f, WIF 0xef, bip32 0x043587cf/0x04358394).
                // NOT Dogecoin-testnet prefixes (0x71/0xf1); the encoder would
                // produce addresses the running node treats as invalid.
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x043587cf,
                       "private": 0x04358394
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 100000,
                    "supportsSegwit": false,
                    "singleOpReturnPolicy": false
                }
            case "litecoin-mainnet":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'ltc',
                    "bip32": {
                       "public": 0x019da462,
                       "private": 0x019d9cfe
                    },
                    "pubKeyHash": 0x30,
                    "scriptHash": 0x32,
                    "wif": 0xb0,
                    "dustThreshold": 5460,
                    "minStandardTxNonWitnessSize": 85,
                    // LTC permits larger/multiple OP_RETURN outputs; no single-output size guard
                    "singleOpReturnPolicy": false
                }
            case "litecoin-testnet":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'tltc',
                    "bip32": {
                       "public": 0x0436f6e1,
                       "private": 0x0436ef7d
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 5460,
                    "minStandardTxNonWitnessSize": 85,
                    "singleOpReturnPolicy": false
                }
            case "litecoin-regtest":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'rltc',
                    "bip32": {
                       "public": 0x0436f6e1,
                       "private": 0x0436ef7d
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 5460,
                    "minStandardTxNonWitnessSize": 85,
                    "singleOpReturnPolicy": false
                }
            default:
                throw new TypeError(`Unknown network: "${networkName}". Supported: bitcoin-mainnet, bitcoin-testnet, bitcoin-regtest, dogecoin-mainnet, dogecoin-testnet, dogecoin-regtest, litecoin-mainnet, litecoin-testnet, litecoin-regtest`)
        }
    }
    
    static getFirstBlock(networkName){
        //TODO: this should get a config file from a server
        switch(networkName){
            case "bitcoin-mainnet":
                return 900000
            case "bitcoin-testnet":
                return 100000
            case "litecoin-mainnet":
                return 3000000
            case "litecoin-testnet":
                return 4470000
            case "dogecoin-mainnet":
                return 6000000
            case "dogecoin-testnet":
                // DOGE testnet mints min-difficulty blocks ~every 20s, so the
                // chain runs tens of millions of blocks ahead of the other
                // networks. Anchor near the current tip to avoid indexing ~42M
                // pre-launch blocks (which bloated the decoder DB to ~13.8GB).
                return 62500000
            // All regtest networks start parsing at block 0
            default:
                return 0
        }
    }
}

module.exports = CryptoNetworks