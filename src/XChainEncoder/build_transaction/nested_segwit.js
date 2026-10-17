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
 * XChain Encoder - Encoder Class
 *
 * This file recognises P2SH-wrapped P2WPKH (nested segwit) funding inputs
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib');

// Only a compressed key has a standard P2WPKH script.
const COMPRESSED_PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/

// The P2WPKH redeem script of the caller's key, or null when the key has none.
function p2wpkhRedeemFor(keyHex, network){
    try {
        return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyHex, 'hex'), network }).output
    } catch (e) {
        return null
    }
}

// The redeem script of a P2SH-P2WPKH funding UTXO, or null for any other script.
// A P2SH scriptPubKey is only a hash, so the redeem script comes from the public key
// the request carries (pubkey or compressedPubKey) and counts only when it hashes to
// the UTXO's script. A P2SH no supplied key matches, or one built with no key at all
// (a bare P2SH address does not say whether it is nested segwit or, say, multisig),
// stays a legacy input with its whole previous transaction.
function nestedP2wpkhRedeem(build, utxo){
    // Verify the chain has segwit: elsewhere a P2SH output is only ever legacy
    if (this.network.supportsSegwit === false) return null
    const script = Buffer.from(utxo.scriptPubKey, 'hex')
    // Verify the output is P2SH (OP_HASH160 <20> OP_EQUAL)
    if (script.length !== 23 || script[0] !== 0xa9 || script[1] !== 0x14 || script[22] !== 0x87) return null
    const keys = [build.pubkey, build.compressedPubKey].filter(k => typeof k === 'string' && COMPRESSED_PUBKEY_RE.test(k))
    for (const key of keys){
        const redeem = p2wpkhRedeemFor(key, this.network)
        if (redeem && bitcoin.payments.p2sh({ redeem: { output: redeem }, network: this.network }).output.equals(script)) return redeem
    }
    return null
}

module.exports = { nestedP2wpkhRedeem }
