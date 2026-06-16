// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Relative fee-rate cap.
//
// Bug: with MAX_FEE_RATE_KB unset (the default), a caller-supplied fee or
// feePerKb had no upper bound short of the gross 2.1T-sat validator limit, so
// a malicious or buggy caller could set them high enough that every selected
// input is drained into miner fee — the user signs the PSBT none the wiser.
//
// Fix: caller-supplied rates are capped at maxFeeRateMultiplier × the node's
// own estimatesmartfee(1) estimate (default 100×). feePerKb is clamped; an
// explicit absolute fee is rejected with a RangeError (silently lowering an
// exact amount would change what the caller signs). The cap degrades
// gracefully when the node cannot produce an estimate (quiet testnets).

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)

const DOGE_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('dogecoin-regtest')
const TEST_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf,
  network: DOGE_REGTEST
}).address

const INPUT_VALUE = 100000000 // 1 coin in base units

function makeSegwitUtxo (txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  })
  return {
    txid,
    vout,
    value,
    confirmations: 6,
    scriptPubKey: p2wpkh.output.toString('hex')
  }
}

// Node estimate mocked at 0.00001 coin/kB = 1 sat/byte, so the default 100×
// multiplier caps the effective rate at 100 sat/byte.
function makeEncoder (maxFeeRateKb = null, maxFeeRateMultiplier = undefined) {
  const encoder = maxFeeRateMultiplier === undefined
    ? new XChainEncoder('dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '', maxFeeRateKb)
    : new XChainEncoder('dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '', maxFeeRateKb, maxFeeRateMultiplier)
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001
  }
  // dogecoin-regtest's dust floor is 100000 koinu — orders of magnitude above
  // the sub-dust fees these rate-cap probes produce (a ~131-byte tx capped at
  // ~100 sat/byte pays ~13100). The dust floor is exercised by its own suite;
  // override it here so the rate-cap behaviour under test is observable.
  encoder.dustAmount = 546
  return encoder
}

// inputs − all outputs = the fee actually embedded in the PSBT
function paidFee (result) {
  const outputs = result.psbt.txOutputs.reduce((sum, o) => sum + o.value, 0)
  return INPUT_VALUE - outputs
}

async function create (encoder, { fee = null, feePerKb = null } = {}) {
  return encoder.createTransaction(
    [makeSegwitUtxo(TXID_A, 0, INPUT_VALUE)], TEST_ADDRESS, null,
    'test', null, fee, false, null, TEST_ADDRESS,
    null, null, null, true, feePerKb
  )
}

describe('XChainEncoder fee-rate cap', () => {

  it('rejects a drain-shaped absolute fee with a RangeError', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      create(encoder, { fee: INPUT_VALUE }), // entire input as miner fee
      (err) => err instanceof RangeError && /fee-rate cap/.test(err.message)
    )
  })

  it('accepts a generous but plausible absolute fee (priority/RBF headroom)', async () => {
    const encoder = makeEncoder()
    const fee = 10000 // ~76 sat/byte vs a 1 sat/byte estimate — under the 100× cap
    const result = await create(encoder, { fee })
    assert.strictEqual(paidFee(result), fee)
  })

  it('clamps an over-cap feePerKb to the relative cap instead of draining inputs', async () => {
    const encoder = makeEncoder()
    // 0.01 coin/kB = 1000 sat/byte = 1000× the node estimate
    const result = await create(encoder, { feePerKb: 0.01 })
    // At the clamped 100 sat/byte a ~131-byte tx pays ~13100 sats; unclamped it
    // would pay ~131000.
    assert.ok(paidFee(result) <= 20000,
      `fee ${paidFee(result)} should have been clamped to ~100 sat/byte`)
  })

  it('falls back gracefully when the node cannot estimate (caller feePerKb honored)', async () => {
    const encoder = makeEncoder()
    encoder.connector = {
      getFeePerKilobyte: async () => { throw new Error('Error getting smart fee from node') }
    }
    // Quiet-testnet scenario: callers must supply feePerKb because the node has
    // no estimate; with no anchor (and no MAX_FEE_RATE_KB) the rate is honored.
    const result = await create(encoder, { feePerKb: 0.01 })
    assert.ok(paidFee(result) >= 100000,
      `fee ${paidFee(result)} should reflect the unclamped 1000 sat/byte rate`)
  })

  it('applies the absolute MAX_FEE_RATE_KB cap when it is tighter than the relative cap', async () => {
    const encoder = makeEncoder(50000) // 50000 sat/kB = 50 sat/byte < 100× estimate
    const result = await create(encoder, { feePerKb: 0.01 })
    assert.ok(paidFee(result) <= 10000,
      `fee ${paidFee(result)} should have been clamped to ~50 sat/byte`)
  })

  it('caps the absolute fee against MAX_FEE_RATE_KB even without a node estimate', async () => {
    const encoder = makeEncoder(50000)
    encoder.connector = {
      getFeePerKilobyte: async () => { throw new Error('Error getting smart fee from node') }
    }
    await assert.rejects(
      create(encoder, { fee: INPUT_VALUE, feePerKb: 0.01 }),
      (err) => err instanceof RangeError && /fee-rate cap/.test(err.message)
    )
  })

  it('multiplier 0 disables the relative cap', async () => {
    const encoder = makeEncoder(null, 0)
    const fee = 50000 // 382 sat/byte — above the default cap
    const result = await create(encoder, { fee })
    assert.strictEqual(paidFee(result), fee)
  })

  it('default-path node estimate is never clamped by its own cap', async () => {
    const encoder = makeEncoder()
    const result = await create(encoder, {}) // no fee, no feePerKb
    // 1 sat/byte on a ~131-byte tx ≈ 131 sats, floored to dust (546)
    assert.ok(paidFee(result) <= 1000,
      `fee ${paidFee(result)} should be the node-estimate fee, not a clamped value`)
  })
})
