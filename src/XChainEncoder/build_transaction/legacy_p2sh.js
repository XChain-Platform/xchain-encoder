/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib')

// Return caller-supplied signing metadata only when it opens this P2SH output.
function matchingLegacyRedeemScript(utxo){
    let redeemScript = utxo.redeemScript
    if (typeof redeemScript === 'string'){
        if (!/^(?:[0-9a-fA-F]{2})+$/.test(redeemScript)) return null
        redeemScript = Buffer.from(redeemScript, 'hex')
    }
    if (!Buffer.isBuffer(redeemScript)) return null
    const scriptPubKey = Buffer.from(utxo.scriptPubKey, 'hex')
    if (scriptPubKey.length !== 23 || scriptPubKey[0] !== 0xa9 ||
        scriptPubKey[1] !== 0x14 || scriptPubKey[22] !== 0x87) return null
    return bitcoin.crypto.hash160(redeemScript).equals(scriptPubKey.subarray(2, 22))
        ? redeemScript : null
}

module.exports = { matchingLegacyRedeemScript }
