// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../../src/XChainEncoder')

const SATOSHI_UNIT = 100000000
const NETWORK = 'dogecoin-regtest'
const NET = require('../../../../src/build/crypto_networks').getBitcoinJsNetwork(NETWORK)
const PUBKEY = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
const CALLER = bitcoin.payments.p2pkh({ pubkey: PUBKEY, network: NET }).address
const RATE_KB = 1000000
const INPUT_VALUE = 2000000
const FIXED_COMMIT_FEE = 100000

function previousTransaction () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  for (let i = 0; i < 4; i++) {
    tx.addOutput(bitcoin.payments.p2pkh({ pubkey: PUBKEY, network: bitcoin.networks.regtest }).output, INPUT_VALUE)
  }
  return tx
}

function makeEncoder (commitPackage) {
  const encoder = new XChainEncoder(NETWORK, '', '', '', '', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.01,
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async () => previousTransaction().toHex(),
    getUnconfirmedAncestorPackage: async () => commitPackage
  }
  return encoder
}

function utxos () {
  const tx = previousTransaction()
  const script = bitcoin.payments.p2pkh({ pubkey: PUBKEY, network: bitcoin.networks.regtest }).output
  return [0, 1, 2, 3].map(vout => ({
    txid: tx.getId(), vout, value: INPUT_VALUE, confirmations: 6, scriptPubKey: script.toString('hex')
  }))
}

async function buildFunding () {
  const encoder = makeEncoder({ size: 0, fees: 0 })
  const result = await encoder.createTransaction(
    utxos(), CALLER, null, 'x'.repeat(400), null, FIXED_COMMIT_FEE, false,
    'P2SH', CALLER, null, null, null, true, RATE_KB)
  const tx = result.psbt.__CACHE.__TX
  const leg = tx.outs.find(o => o.script.toString('hex').startsWith('a914'))
  const extra = 200000000
  leg.value = typeof leg.value === 'bigint' ? leg.value + BigInt(extra) : leg.value + extra
  return tx
}

async function buildReveal (encoder, funding) {
  const result = await encoder.createTransaction(
    [], CALLER, null, 'x'.repeat(400), null, null, false,
    'P2SH', CALLER, funding.getId(), funding.toHex(), null, true, RATE_KB)
  return result.psbt.__CACHE.__TX
}

function legTotal (tx) {
  return tx.outs.filter(o => o.script.toString('hex').startsWith('a914'))
    .reduce((sum, out) => sum + Number(out.value), 0)
}

function outputTotal (tx) {
  return tx.outs.reduce((sum, out) => sum + Number(out.value), 0)
}

describe('P2SH reveal uplift ceilings', function () {
  let previousUplift

  beforeEach(function () {
    previousUplift = process.env.MAX_CPFP_UPLIFT_SAT
    process.env.MAX_CPFP_UPLIFT_SAT = '1000000000'
  })

  afterEach(function () {
    if (previousUplift === undefined) delete process.env.MAX_CPFP_UPLIFT_SAT
    else process.env.MAX_CPFP_UPLIFT_SAT = previousUplift
  })

  it('keeps the fixed burn backstop when the relative fee cap is disabled', async function () {
    const funding = await buildFunding()
    const control = await buildReveal(makeEncoder(undefined), funding)
    const encoder = makeEncoder({ size: 80000, fees: 0.0008 })
    encoder.maxFeePerBytes = null
    encoder.maxFeeRateMultiplier = null
    const reveal = await buildReveal(encoder, funding)
    const revealFee = legTotal(funding) - outputTotal(reveal)
    const controlFee = legTotal(funding) - outputTotal(control)
    const fairFee = controlFee
    const ceiling = Math.max(encoder.dustAmount, fairFee * 100)
    assert.ok(revealFee <= ceiling, `reveal fee ${revealFee} exceeds burn ceiling ${ceiling}`)
    assert.ok(outputTotal(reveal) > 0, 'the reveal must sweep the unused leg value')
  })

  it('keeps the operator rate cap below the fixed backstop', async function () {
    const funding = await buildFunding()
    const control = await buildReveal(makeEncoder(undefined), funding)
    const encoder = makeEncoder({ size: 80000, fees: 0.0008 })
    const capPerByte = 20000
    encoder.maxFeePerBytes = capPerByte / SATOSHI_UNIT
    encoder.maxFeeRateMultiplier = null
    const reveal = await buildReveal(encoder, funding)
    const revealFee = legTotal(funding) - outputTotal(reveal)
    const controlFee = legTotal(funding) - outputTotal(control)
    const revealSizeForFee = controlFee / 1000
    const ceiling = Math.max(encoder.dustAmount, Math.ceil(revealSizeForFee * capPerByte))
    assert.ok(revealFee <= ceiling, `reveal fee ${revealFee} exceeds rate-cap ceiling ${ceiling}`)
  })
})
