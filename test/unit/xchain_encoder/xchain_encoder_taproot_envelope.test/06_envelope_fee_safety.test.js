// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../../../src/XChainEncoder')
const TxSizeEstimator = require('../../../../src/build/tx_size_estimator')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY = Buffer.from(KEY.publicKey)
const PUBKEY_HEX = PUBKEY.toString('hex')
const TXID = 'a'.repeat(64)
const SATOSHI_UNIT = 100000000

function makeEncoder (estimate = 0.00001, relayfee = 0.00001, networkKey = 'bitcoin-regtest') {
  const encoder = new XChainEncoder(networkKey, '', '', '', '', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => estimate,
    getNetworkInfo: async () => ({ relayfee }),
    getTransactionHex: async () => { throw new Error('unexpected previous transaction lookup') }
  }
  return encoder
}

function address (encoder) {
  return bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network: encoder.network }).address
}

function segwitUtxo (encoder, value = 300000000) {
  const script = bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network: encoder.network }).output
  return { txid: TXID, vout: 0, value, confirmations: 6, scriptPubKey: script.toString('hex') }
}

function buildEnvelope (encoder, { dust = null, feePerKb = 1000 } = {}) {
  return encoder.createTransaction(
    [segwitUtxo(encoder)], address(encoder), null, 'FILE|0|fee-safety', 'x'.repeat(200),
    null, false, 'TAPROOT', address(encoder), null, null, PUBKEY_HEX,
    true, feePerKb, dust)
}

function cancelRecord (encoder, value = 100000) {
  return {
    commitTxid: 'b'.repeat(64), commitVout: 0, commitValue: value,
    internalPubkey: PUBKEY.subarray(1).toString('hex'), tapleafHash: 'c'.repeat(64),
    destination: address(encoder)
  }
}

describe('TAPROOT envelope fee safety', function () {
  it('returns a large caller dust value as reveal change instead of miner fee', async function () {
    const result = await buildEnvelope(makeEncoder(), { dust: 100000000 })
    assert.strictEqual(Number(result.revealPsbt.txOutputs[0].value), 100000000)
    assert.ok(result.envelope.revealFee < 100000000)
    assert.strictEqual(result.envelope.commitValue, result.envelope.revealFee + 100000000)
  })

  it('returns a raised operator output floor as reveal change instead of miner fee', async function () {
    const encoder = makeEncoder()
    encoder.outputFloor = 100000000
    const result = await buildEnvelope(encoder)
    assert.strictEqual(Number(result.revealPsbt.txOutputs[0].value), encoder.outputFloor)
    assert.ok(result.envelope.revealFee < encoder.outputFloor)
  })

  it('keeps the reveal base fee within the fixed burn backstop', async function () {
    const encoder = makeEncoder()
    encoder.maxFeePerBytes = null
    encoder.maxFeeRateMultiplier = null
    const result = await buildEnvelope(encoder, { feePerKb: 1000000 })
    const outputBytes = TxSizeEstimator.estimateOutputSizeForAddress(address(encoder), encoder.network)
    const scriptBytes = Buffer.from(result.carrierScripts[0], 'hex').length
    const revealSize = TxSizeEstimator.estimateEnvelopeRevealTx(scriptBytes, outputBytes)
    assert.ok(result.envelope.revealFee <= revealSize * 100)
  })
})

describe('TAPROOT envelope cancel suggested ceiling', function () {
  it('clamps a node-selected cancel rate to the test-chain suggested ceiling', async function () {
    const high = await makeEncoder(0.00376).createEnvelopeCancelTransaction(cancelRecord(makeEncoder()))
    const ceiling = await makeEncoder(0.0002).createEnvelopeCancelTransaction(cancelRecord(makeEncoder()))
    assert.strictEqual(high.fee, ceiling.fee)
  })

  it('prices a node-selected cancel at the default 20 per vByte ceiling, not the raw estimate', async function () {
    const encoder = makeEncoder(0.00376)
    const cancel = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    assert.strictEqual(cancel.fee, 2040)
    assert.strictEqual(Number(cancel.psbt.txOutputs[0].value), 100000 - 2040)
  })

  it('honours SUGGESTED_FEE_MAX_PER_VBYTE for a node-selected cancel rate', async function () {
    process.env.SUGGESTED_FEE_MAX_PER_VBYTE = '30'
    try {
      const encoder = makeEncoder(0.00376)
      const cancel = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
      assert.strictEqual(cancel.fee, 3060)
    } finally {
      delete process.env.SUGGESTED_FEE_MAX_PER_VBYTE
    }
  })

  it('leaves a caller cancel feePerKb above the suggested ceiling unclamped', async function () {
    const encoder = makeEncoder(0.00376)
    const cancel = await encoder.createEnvelopeCancelTransaction({ ...cancelRecord(encoder), feePerKb: 50000 })
    assert.strictEqual(cancel.fee, 50 * 102)
  })

  it('leaves a mainnet node-selected cancel rate unclamped', async function () {
    const encoder = makeEncoder(0.00376, 0.00001, 'bitcoin-mainnet')
    const cancel = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    assert.strictEqual(cancel.fee, 376 * 102)
  })
})

describe('TAPROOT envelope cancel relay floor', function () {
  it('raises an automatic cancel rate to the relay floor', async function () {
    const encoder = makeEncoder(0.00001, 0.0001)
    const cancel = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    assert.strictEqual(cancel.fee, 1020)
    assert.strictEqual(Number(cancel.psbt.txOutputs[0].value), 100000 - cancel.fee)
  })

  it('refuses an automatic cancel when the configured cap blocks relay', async function () {
    const encoder = makeEncoder(0.00001, 0.0001)
    encoder.maxFeePerBytes = 5000 / 1000 / SATOSHI_UNIT
    await assert.rejects(encoder.createEnvelopeCancelTransaction(cancelRecord(encoder)), err => {
      assert.ok(!(err instanceof RangeError))
      assert.match(err.message, /below the node relay minimum/)
      return true
    })
    assert.strictEqual(encoder.outpointReservations.size, 0)
  })

  it('allows the dust fee floor to make an automatic cancel relayable', async function () {
    const encoder = makeEncoder(0.00001, 0.00005)
    encoder.maxFeePerBytes = 3000 / 1000 / SATOSHI_UNIT
    const cancel = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    assert.strictEqual(cancel.fee, encoder.dustAmount)
  })
})
