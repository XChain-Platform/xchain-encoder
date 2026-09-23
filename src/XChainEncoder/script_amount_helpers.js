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
 * This file handles starting the encoder and generating transactions
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib');
const coins = require('../coins')
const { SOFT_DUST_FLOOR_BY_COIN, TAPROOT_LEAF_VERSION, MAX_SAFE_SATOSHI_BIG } = require('./constants.js')

// Keyed on the coin, not the network: the soft limit is node policy on every Dogecoin chain.
function softDustFloorFor(networkKey){
    const fullName = String(networkKey || '').slice(0, Math.max(0, String(networkKey || '').lastIndexOf('-')))
    const tick = coins.FULL_NAME_TO_TICK[fullName]
    return (tick && SOFT_DUST_FLOOR_BY_COIN[tick]) || 0
}

// Byte width of the compactSize varint that prefixes a length on the wire.
// Distinct from compiledPushSize: that models bitcoin.script.compile's PUSH
// OPCODE framing (direct push / OP_PUSHDATA1 / OP_PUSHDATA2) and is correct
// only INSIDE a script. Witness-stack items are not script pushes; each is
// framed by a compactSize varint, which switches width at 253, not at 76/256.
function compactSizeLen(n) {
    if (n < 253) return 1
    if (n <= 0xffff) return 3
    if (n <= 0xffffffff) return 5
    return 9
}

// Serialized compactSize varint for `n`, the wire form whose width
// compactSizeLen models. Needed for the BIP341 tapleaf hash, whose preimage
// length-prefixes the script with a compactSize (not a script push).
function compactSizeBuffer(n) {
    if (n < 253) return Buffer.from([n])
    if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b }
    const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b
}

// BIP341 tapleaf hash of the envelope script:
// taggedHash("TapLeaf", leaf_version || compactSize(len(script)) || script).
// For the single-leaf envelope tree this doubles as the taproot merkle root,
// which is exactly the third element of the wallet's cancel-recovery record
// {commit outpoint, internal key derivation path, tapleaf hash}: the key-path
// tweak cannot be reconstructed without it.
function envelopeTapLeafHash(script) {
    return bitcoin.crypto.taggedHash('TapLeaf',
        Buffer.concat([Buffer.from([TAPROOT_LEAF_VERSION]), compactSizeBuffer(script.length), script]))
}

// bitcoinjs-lib refuses any P2TR construction until an ECC backend is
// registered. Registered lazily on the first envelope build rather than at
// module load so the non-envelope lanes (and the browserify bundle) never pay
// for the wasm-backed tiny-secp256k1 at startup.
let eccLibReady = false
function ensureEccLib() {
    if (eccLibReady) return
    bitcoin.initEccLib(require('tiny-secp256k1'))
    eccLibReady = true
}

// Narrow a satoshi amount computed in BigInt back to a Number when it is
// exactly representable, so consumers predating BigInt support (tests, PSBT
// inspectors) keep seeing Number for every value they could handle; only a
// genuinely >2^53-1 amount stays BigInt (the patched bitcoinjs/bip174
// serializers accept both).
function asSatValue(v) {
    return (typeof v === 'bigint' && v <= MAX_SAFE_SATOSHI_BIG) ? Number(v) : v
}

// JSON-safe form of a satoshi amount for OperationalError metadata:
// JSON.stringify throws on BigInt, so a >2^53-1 amount is emitted as its
// exact decimal string instead.
function jsonSafeSat(v) {
    if (typeof v !== 'bigint') return v
    return v <= MAX_SAFE_SATOSHI_BIG ? Number(v) : v.toString()
}

module.exports = { softDustFloorFor, compactSizeLen, envelopeTapLeafHash, ensureEccLib, asSatValue, jsonSafeSat }
