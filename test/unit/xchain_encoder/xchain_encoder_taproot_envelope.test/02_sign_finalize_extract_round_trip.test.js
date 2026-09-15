// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//

const assert = require('assert')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../../src/XChainEncoder')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY_HEX = Buffer.from(KEY.publicKey).toString('hex')
const XONLY = Buffer.from(KEY.publicKey).subarray(1, 33)

const TXID_A = 'a'.repeat(64)

const TAPROOT_LEAF_VERSION = 0xc0

function makeSegwitUtxo (network, txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network })
  return { txid, vout, value, confirmations: 6, scriptPubKey: p2wpkh.output.toString('hex') }
}

function makeEncoder (networkName = 'bitcoin-regtest') {
  const encoder = new XChainEncoder(networkName, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001, // 1 sat/byte
    getTransactionHex: async () => { throw new Error('unit test: no node') }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
  }
  return encoder
}

function callerAddress (network) {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network }).address
}

function unsignedTx (psbt) {
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
}

async function signsBothHalves () {
  const encoder = makeEncoder()
  const network = encoder.network
  const utxos = [makeSegwitUtxo(network, TXID_A, 0, 10000000)]
  const raw = crypto.randomBytes(4000).toString('binary')
  const result = await encoder.createTransaction(
    utxos, callerAddress(network), null, 'FILE|0|sign-test', raw,
    null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)

  // Sign the commit (ordinary p2wpkh inputs, SIGHASH_ALL as instructed).
  const signer = {
    publicKey: Buffer.from(KEY.publicKey),
    sign: (h) => Buffer.from(KEY.sign(h))
  }
  result.psbt.signAllInputs(signer)
  result.psbt.finalizeAllInputs()
  const commitTx = result.psbt.extractTransaction()
  assert.strictEqual(commitTx.getId(), result.envelope.commitTxid,
    'signing did not move the segwit-only commit txid')

  // Sign the reveal via the script path with the internal key.
  const revealSigner = {
    publicKey: Buffer.from(KEY.publicKey),
    signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, KEY.privateKey))
  }
  result.revealPsbt.signInput(0, revealSigner)
  result.revealPsbt.finalizeAllInputs()
  const revealTx = result.revealPsbt.extractTransaction()

  // Witness stack: [schnorr sig, envelope script, control block].
  const witness = revealTx.ins[0].witness
  assert.strictEqual(witness.length, 3)
  assert.strictEqual(witness[1].toString('hex'), result.carrierScripts[0])
  assert.strictEqual(witness[2].toString('hex'), result.envelope.controlBlock)
  assert.strictEqual(Buffer.from(revealTx.ins[0].hash).reverse().toString('hex'), commitTx.getId())

  // The schnorr signature verifies against the leaf sighash.
  const leafHash = bitcoin.crypto.taggedHash('TapLeaf', Buffer.concat([
    Buffer.from([TAPROOT_LEAF_VERSION]),
    // compactSize prefix of the script length (script < 65536 here -> 0xfd form or single byte)
    (function (n) {
      if (n < 253) return Buffer.from([n])
      const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b
    })(witness[1].length),
    witness[1]
  ]))
  assert.strictEqual(leafHash.toString('hex'), result.envelope.tapleafHash)
  const sighash = revealTx.hashForWitnessV1(
    0, [commitTx.outs[0].script], [commitTx.outs[0].value],
    bitcoin.Transaction.SIGHASH_DEFAULT, leafHash)
  assert.ok(ecc.verifySchnorr(sighash, XONLY, witness[0]), 'schnorr signature verifies')

  // Estimator accuracy: the funded reveal fee covers the actual vsize at
  // the quoted 1 sat/vB and does not over-fund by more than the margin.
  const actualVsize = revealTx.virtualSize()
  assert.ok(result.envelope.revealFee >= actualVsize,
    `reveal prefund ${result.envelope.revealFee} covers actual vsize ${actualVsize}`)
  assert.ok(result.envelope.revealFee <= actualVsize + 16,
    `reveal prefund ${result.envelope.revealFee} within margin of actual ${actualVsize}`)
}

describe('XChainEncoder TAPROOT envelope', function () {
  describe('sign/finalize/extract round trip (commit -> reveal -> estimator accuracy)', function () {
    it('signs both halves; the signed commit txid matches the pre-built reveal outpoint', signsBothHalves)
  })
})
