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
 * In-process BigInt-safe 64-bit value patch for bitcoinjs-lib + bip174.
 *
 * Stock bitcoinjs-lib 6.x holds transaction output values as Number and
 * bounds them twice: the 64-bit serializers (bufferutils verifuint, and
 * bip174's own copy for the PSBT witnessUtxo field) throw 'RangeError:
 * value out of range' above 2^53-1, and types.Satoshi additionally caps
 * addOutput at 21M BTC in sats (2.1e15). Dogecoin has no supply cap, so a
 * single output can legitimately exceed both ceilings (>~90.07M DOGE for
 * 2^53); without this patch the encoder cannot build such a PSBT at all.
 *
 * This is the WRITE-SIDE contract, shared with xchain-sdk/src/utils/
 * apply_bufferutils_patch.js: the patch teaches the loaded modules to carry a
 * satoshi value as either a Number (unchanged fast path) or a BigInt up to
 * 2^64-1 (the wire format's true ceiling). Readers return a Number whenever
 * the value is exactly representable and a BigInt only above 2^53-1, so
 * existing Number-based callers see identical behavior for every value they
 * could already handle. The READ-SIDE copies (xchain-decoder's
 * src/chain/apply_bufferutils_patch.js and xchain-utxo-tracker's
 * src/chain/apply_bufferutils_patch.js) lift the same 2^53 wall
 * for block decode but deliberately implement a DIFFERENT contract:
 * BufferReader.readUInt64 always returns a BigInt and the module-level
 * readUInt64LE/writeUInt64LE helpers keep the stock 2^53-1 ceiling. Only the
 * 2^53 probe and the error strings are common to both, so this file is NOT a
 * drop-in for either read-side copy and neither of those is one for this.
 *
 * Re-sync seam (uuid:311476c7). Everything below this banner is pinned
 * byte-identical to the SDK copy's body by
 * test/unit/build/apply_bufferutils_patch.test.js. Convergence runs SDK-ward: change
 * the SDK copy first, then copy its body here. Only the two headers differ,
 * because each names the other and its own read-side relationship.
 *
 * All bitcoinjs-lib/bip174 consumers hold the patched modules' exports
 * objects and class prototypes rather than destructured copies, so
 * mutating them here retrofits every current and future caller.
 *
 ********************************************************************/

require('./apply_bufferutils_patch/v7')
require('./apply_bufferutils_patch/v6')

module.exports = require('bitcoinjs-lib/src/bufferutils')
