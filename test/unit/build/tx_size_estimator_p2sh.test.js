// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const TxSizeEstimator = require('../../../src/build/tx_size_estimator')

const ECPair = ECPairFactory(ecc)

function compactSizeLength (length) {
  if (length < 0xfd) return 1
  if (length <= 0xffff) return 3
  if (length <= 0xffffffff) return 5
  return 9
}

function generatedKey (label, compressed) {
  let attempt = 0
  while (true) {
    const privateKey = crypto.createHash('sha256')
      .update(`${label}:${attempt++}`)
      .digest()
    if (ecc.isPrivate(privateKey)) return ECPair.fromPrivateKey(privateKey, { compressed })
  }
}

function signedLegacyP2shMultisigInput (m, n, compressed) {
  const keys = Array.from(
    { length: n },
    (_, index) => generatedKey(`${m}-of-${n}:${compressed}:${index}`, compressed)
  )
  const redeemScript = bitcoin.payments.p2ms({
    m,
    pubkeys: keys.map(key => Buffer.from(key.publicKey))
  }).output
  const scriptPubKey = bitcoin.script.compile([
    bitcoin.opcodes.OP_HASH160,
    bitcoin.crypto.hash160(redeemScript),
    bitcoin.opcodes.OP_EQUAL
  ])
  const previous = new bitcoin.Transaction()
  previous.addInput(Buffer.alloc(32), 0)
  previous.addOutput(scriptPubKey, 1000000)

  const spend = new bitcoin.Transaction()
  spend.addInput(previous.getHash(), 0)
  spend.addOutput(Buffer.from([bitcoin.opcodes.OP_RETURN]), 0)
  const sighashType = bitcoin.Transaction.SIGHASH_ALL
  const digest = spend.hashForSignature(0, redeemScript, sighashType)
  const signatures = keys.slice(0, m).map(key =>
    bitcoin.script.signature.encode(Buffer.from(key.sign(digest)), sighashType)
  )
  spend.ins[0].script = bitcoin.script.compile([
    bitcoin.opcodes.OP_0,
    ...signatures,
    redeemScript
  ])

  return {
    actual: 40 + compactSizeLength(spend.ins[0].script.length) + spend.ins[0].script.length,
    redeemScript,
    utxo: {
      hash: previous.getHash(),
      index: 0,
      sequence: 0xffffffff,
      nonWitnessUtxo: previous.toBuffer(),
      redeemScript
    }
  }
}

describe('TxSizeEstimator legacy P2SH multisig inputs', function () {
  it('keeps the unknown-P2SH estimate for unusable signing metadata', function () {
    const signed = signedLegacyP2shMultisigInput(2, 3, true)
    const missing = Object.assign({}, signed.utxo, { redeemScript: undefined })
    const malformed = Object.assign({}, signed.utxo, {
      redeemScript: Buffer.from([bitcoin.opcodes.OP_TRUE])
    })
    const mismatched = Object.assign({}, signed.utxo, {
      redeemScript: signedLegacyP2shMultisigInput(1, 1, true).redeemScript
    })

    assert.strictEqual(TxSizeEstimator.estimateInputSize(missing), 289)
    assert.strictEqual(TxSizeEstimator.estimateInputSize(malformed), 289)
    assert.strictEqual(TxSizeEstimator.estimateInputSize(mismatched), 289)
  })

  for (const [m, n] of [[1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [3, 5], [15, 15]]) {
    for (const compressed of [true, false]) {
      const keyForm = compressed ? 'compressed' : 'uncompressed'
      it(`covers a signed ${m}-of-${n} P2SH input with ${keyForm} generated keys`, function () {
        const signed = signedLegacyP2shMultisigInput(m, n, compressed)
        const signaturePushBytes = 1 + 73
        const redeemPushBytes = signed.redeemScript.length < 76
          ? 1
          : signed.redeemScript.length <= 0xff ? 2 : 3
        const worstCaseScriptSig = 1 + (m * signaturePushBytes) +
          redeemPushBytes + signed.redeemScript.length
        const expected = 40 + compactSizeLength(worstCaseScriptSig) + worstCaseScriptSig
        const estimate = TxSizeEstimator.estimateInputSize(signed.utxo)

        assert.strictEqual(estimate, expected)
        assert.ok(estimate >= signed.actual,
          `estimate ${estimate} is below signed input size ${signed.actual}`)
      })
    }
  }
})
