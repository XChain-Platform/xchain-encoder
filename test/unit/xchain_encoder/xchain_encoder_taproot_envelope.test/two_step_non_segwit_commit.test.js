// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../../../src/XChainEncoder')
const validator = require('../../../../src/common/validator')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 19))
const PUBKEY = Buffer.from(KEY.publicKey)
const PUBKEY_HEX = PUBKEY.toString('hex')

function signer () {
  return {
    publicKey: PUBKEY,
    sign: hash => Buffer.from(KEY.sign(hash))
  }
}

function revealSigner () {
  return {
    publicKey: PUBKEY,
    signSchnorr: hash => Buffer.from(ecc.signSchnorr(hash, KEY.privateKey))
  }
}

function fundingTransaction (script, value) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 3), 0xffffffff, 0xffffffff, Buffer.from([0]))
  tx.addOutput(script, value)
  return tx
}

function fixture (kind) {
  const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  const network = encoder.network
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network })
  const payment = kind === 'p2pkh'
    ? bitcoin.payments.p2pkh({ pubkey: PUBKEY, network })
    : bitcoin.payments.p2sh({ redeem: p2wpkh, network })
  const previous = fundingTransaction(payment.output, 1000000)
  const utxo = {
    txid: previous.getId(),
    vout: 0,
    value: 1000000,
    confirmations: 6,
    scriptPubKey: payment.output.toString('hex')
  }
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async txid => {
      if (txid !== previous.getId()) throw new Error('unexpected previous transaction')
      return previous.toHex()
    }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
  }
  return { encoder, utxo, source: payment.address }
}

async function buildPair (kind) {
  const { encoder, utxo, source } = fixture(kind)
  const args = [
    [utxo], source, null, `FILE|0|two-step-${kind}`, 'payload',
    null, false, 'TAPROOT', source, null, null, PUBKEY_HEX
  ]
  const commit = await encoder.createTransaction(...args, true, null, null, null, false, false, {
    twoStepEnvelope: true
  })
  assert.strictEqual(commit.revealPsbt, undefined)
  assert.strictEqual(commit.envelope.commitTxid, undefined)
  assert.strictEqual(commit.carrierScripts.length, 1)

  const unsignedHex = commit.psbt.data.globalMap.unsignedTx.toBuffer().toString('hex')
  commit.psbt.signAllInputs(signer())
  commit.psbt.finalizeAllInputs()
  const commitTx = commit.psbt.extractTransaction()
  assert.notStrictEqual(commitTx.getId(), bitcoin.Transaction.fromHex(unsignedHex).getId())

  const reveal = await encoder.createTransaction(...args, true, null, null, null, false, false, {
    envelopeCommitHex: commitTx.toHex()
  })
  assert.strictEqual(reveal.revealPsbt, undefined)
  assert.strictEqual(reveal.envelope.commitTxid, commitTx.getId())
  assert.strictEqual(Buffer.from(commitTx.ins[0].hash).reverse().toString('hex'), utxo.txid)
  assert.strictEqual(commitTx.ins[0].index, utxo.vout)
  assert.strictEqual(Buffer.from(reveal.psbt.txInputs[0].hash).reverse().toString('hex'), commitTx.getId())
  assert.strictEqual(reveal.psbt.txInputs[0].index, 0)
  assert.strictEqual(reveal.psbt.data.inputs[0].tapLeafScript[0].script.toString('hex'), commit.carrierScripts[0])

  reveal.psbt.signInput(0, revealSigner())
  reveal.psbt.finalizeAllInputs()
  const revealTx = reveal.psbt.extractTransaction()
  assert.strictEqual(Buffer.from(revealTx.ins[0].hash).reverse().toString('hex'), commitTx.getId())
  assert.strictEqual(revealTx.ins[0].index, 0)

  return { encoder, args, unsignedHex }
}

describe('XChainEncoder TAPROOT two-step envelope for non-native-segwit commits', function () {
  it('builds and finalizes a P2PKH-funded commit and reveal with source attribution at input 0', async function () {
    await buildPair('p2pkh')
  })

  it('builds and finalizes a P2SH-P2WPKH-funded commit and reveal with source attribution at input 0', async function () {
    await buildPair('p2sh-p2wpkh')
  })

  it('refuses an unsigned envelopeCommitHex', async function () {
    const { encoder, args, unsignedHex } = await buildPair('p2pkh')
    await assert.rejects(
      encoder.createTransaction(...args, true, null, null, null, false, false, {
        envelopeCommitHex: unsignedHex
      }),
      /must be fully signed/
    )
  })

  it('accepts the two-step option keys while still refusing unknown option keys', function () {
    const base = {
      pubkey: 'sender',
      data: 'FILE|0|options',
      encoding: 'TAPROOT',
      compressedPubKey: PUBKEY_HEX
    }
    assert.doesNotThrow(() => validator.validateAll({ ...base, options: { twoStepEnvelope: true } }))
    assert.throws(
      () => validator.validateAll({ ...base, options: { twoStepEnvelop: true } }),
      /Unknown options key/
    )
  })
})
