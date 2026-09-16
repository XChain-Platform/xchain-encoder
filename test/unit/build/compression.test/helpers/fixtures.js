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
 * Emit-side FILE payload compression (spec Part B), encoder side.
 *
 * The load-bearing assertions here are the REFUSALS. Compression is opt-in and
 * mutates the published ACTION string, so every way it could publish
 * permanently unreadable bytes has to fail closed BEFORE broadcast:
 *  - a non-FILE action has nowhere to record the marker;
 *  - a GATED FILE's COMPRESSION field means inflate-after-decrypt and belongs
 *    to the client that did compress-then-encrypt, never to the encoder;
 *  - a caller-declared codec is never silently re-compressed;
 *  - hyper-compressible payloads are emitted raw, because a compliant reader
 *    would refuse to inflate them (emit-time mirror of the serve guard).
 *
 * Plus the two properties that make the feature safe to ship dark:
 *  - the default (ON, per spec §5.2) and the explicit opt-out;
 *  - the estimator prices the COMPRESSED bytes, not the caller's original.
 */

'use strict'

const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')

const XChainEncoder = require('../../../../../src/XChainEncoder')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY = Buffer.from(KEY.publicKey)
const TXID_A = 'a'.repeat(64)

const PUBLIC_FILE = 'FILE|0|report.txt|text/plain|Report|memo'
const GATED_FILE = 'FILE|0|secret.enc|application/octet-stream|Secret||MYTOKEN|1|' + 'a'.repeat(64)

// Realistically compressible: JSON-ish records compress ~4-5:1, which is a
// real-world FILE profile AND comfortably inside the 150:1 guard. Naive
// repeated text is a bad fixture here: it compresses ~210:1 and would trip the
// emit-time ratio guard, so it exercises a different branch than intended.
function compressibleBytes(n = 40000) {
    let out = ''
    for (let i = 0; out.length < n; i++)
        out += JSON.stringify({ id: i, name: 'item-' + i, value: (i * 7919) % 100000, ok: i % 3 === 0 }) + '\n'
    return Buffer.from(out.slice(0, n), 'utf8')
}

function makeEncoder(networkName = 'bitcoin-regtest') {
    const encoder = new XChainEncoder(networkName, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
    encoder.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => { throw new Error('unit test: no node') }
    }
    encoder.utxoTrackerConnector = {
        getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
    }
    return encoder
}

function segwitUtxo(network, value = 10000000) {
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network })
    return { txid: TXID_A, vout: 0, value, confirmations: 6, scriptPubKey: p2wpkh.output.toString('hex') }
}

function callerAddress(network) {
    return bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network }).address
}

module.exports = {
    PUBKEY,
    TXID_A,
    PUBLIC_FILE,
    GATED_FILE,
    compressibleBytes,
    makeEncoder,
    segwitUtxo,
    callerAddress
}
