// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A negative fee cap (an operator typo such as MAX_FEE_RATE_KB=-1) must fall
// back to the safe default, never clamp every build's rate below zero.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../src/XChainEncoder')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const LTC_REGTEST = require('../../../src/build/crypto_networks').getBitcoinJsNetwork('litecoin-regtest')
const TEST_ADDRESS = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: LTC_REGTEST }).address
const INPUT_VALUE = 100000000
const SEGWIT_SCRIPT = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest }).output.toString('hex')

// Node estimate mocked at 20 sat/byte, so the node-suggested fee sits far above the dust floor.
function makeEncoder (...capArgs) {
  const encoder = new XChainEncoder('litecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '', ...capArgs)
  encoder.connector = {
    getFeePerKilobyte: async () => 0.0002,
    getNetworkInfo: async () => ({ relayfee: 0.00001 })
  }
  encoder.dustAmount = 546
  return encoder
}

// Build with no caller fee or rate, so the node-suggested rate prices it, and return the fee paid.
async function nodeRatedFee (encoder) {
  const result = await encoder.createTransaction(
    [{ txid: 'a'.repeat(64), vout: 0, value: INPUT_VALUE, confirmations: 6, scriptPubKey: SEGWIT_SCRIPT }],
    TEST_ADDRESS, null, 'test', null, null, false, null, TEST_ADDRESS,
    null, null, null, true, null
  )
  return INPUT_VALUE - result.psbt.txOutputs.reduce((sum, o) => sum + o.value, 0)
}

describe('XChainEncoder fee-rate cap sign guard', () => {
  it('treats a zero or negative MAX_FEE_RATE_KB as no absolute cap', () => {
    assert.strictEqual(makeEncoder(-1).maxFeePerBytes, null)
    assert.strictEqual(makeEncoder(0).maxFeePerBytes, null)
    assert.strictEqual(makeEncoder(NaN).maxFeePerBytes, null)
    assert.ok(makeEncoder(50000).maxFeePerBytes > 0, 'a positive cap still applies')
  })

  it('keeps the default multiplier for a negative or NaN MAX_FEE_RATE_MULTIPLIER', () => {
    assert.strictEqual(makeEncoder(null, -1).maxFeeRateMultiplier, 100)
    assert.strictEqual(makeEncoder(null, NaN).maxFeeRateMultiplier, 100)
    assert.strictEqual(makeEncoder(null, 0).maxFeeRateMultiplier, null, '0 still disables the relative cap')
    assert.strictEqual(makeEncoder(null, null).maxFeeRateMultiplier, null, 'null still disables the relative cap')
    assert.strictEqual(makeEncoder(null, 5).maxFeeRateMultiplier, 5)
    assert.strictEqual(makeEncoder(null).maxFeeRateMultiplier, 100)
  })

  it('prices a node-rated build the same under a negative cap as under the defaults', async () => {
    const baseline = await nodeRatedFee(makeEncoder())
    assert.ok(baseline > 546, `baseline fee ${baseline} must sit above the dust floor to be a real probe`)
    assert.strictEqual(await nodeRatedFee(makeEncoder(-1)), baseline,
      'MAX_FEE_RATE_KB=-1 must not clamp the node rate down to a dust-sized fee')
    assert.strictEqual(await nodeRatedFee(makeEncoder(null, -1)), baseline,
      'MAX_FEE_RATE_MULTIPLIER=-1 must not clamp the node rate down to a dust-sized fee')
  })
})
