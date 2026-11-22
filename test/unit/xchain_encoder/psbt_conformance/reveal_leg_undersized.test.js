// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const { logger } = require('../../../../src/XChainEncoder/constants')
const { paymentFor, utxoFor, makeEncoder, build, unsignedTx } = require('../../../helpers/psbt_build_fixtures.js')

const NETWORK = 'bitcoin-regtest'
const FUNDING_RATE = 10000
const REVEAL_RATE = 20000

async function fundAndReveal (encoding, revealRate, customOutputs = null) {
  const prevTxs = new Map()
  const encoder = makeEncoder(NETWORK, { estimate: 0.0002, relayfee: 0.00001, prevTxs })
  const pay = paymentFor('p2wpkh', NETWORK)
  const data = 'x'.repeat(1500)
  const funding = await build(encoder, {
    utxos: [utxoFor(prevTxs, pay.output, 5000000, encoding + revealRate)],
    pubkey: pay.address, data, encoding, change: pay.address, feePerKb: FUNDING_RATE
  })
  const fundingTx = unsignedTx(funding)
  return build(encoder, {
    utxos: [], pubkey: pay.address, data, encoding, change: pay.address,
    p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex(), feePerKb: revealRate, customOutputs
  })
}

describe('outputless reveal leg diagnostics', function () {
  for (const encoding of ['P2WSH', 'P2SH']) {
    it(`${encoding} reports observed amounts when a higher reveal rate consumes the sweep`, async function () {
      const warnings = []
      const originalWarn = logger.warn
      let result
      try {
        logger.warn = (...args) => warnings.push(args.join(' '))
        result = await fundAndReveal(encoding, REVEAL_RATE)
      } finally {
        logger.warn = originalWarn
      }
      assert.strictEqual(result.psbt.txOutputs.length, 1)
      assert.strictEqual(Number(result.psbt.txOutputs[0].value), 0)
      const advisory = result.warnings && result.warnings.find(warning => warning.code === 'REVEAL_LEG_UNDERSIZED')
      assert.ok(advisory, 'the result must expose the undersized reveal warning')
      assert.match(advisory.message, /legs hold \d+ base units/)
      assert.match(advisory.message, /keeps \d+ as fee/)
      assert.match(advisory.message, /output floor of \d+/)
      assert.ok(!/predates/.test(advisory.message))
      assert.ok(warnings.some(warning => /REVEAL_LEG_UNDERSIZED/.test(warning)))
    })

    it(`${encoding} stays quiet when the reveal uses its funding rate`, async function () {
      const warnings = []
      const originalWarn = logger.warn
      let result
      try {
        logger.warn = (...args) => warnings.push(args.join(' '))
        result = await fundAndReveal(encoding, FUNDING_RATE)
      } finally {
        logger.warn = originalWarn
      }
      assert.ok(result.psbt.txOutputs.some(output => BigInt(output.value) > 0n))
      assert.ok(!(result.warnings || []).some(warning => warning.code === 'REVEAL_LEG_UNDERSIZED'))
      assert.ok(!warnings.some(warning => /REVEAL_LEG_UNDERSIZED/.test(warning)))
    })

    it(`${encoding} refuses a reveal whose value output leaves less than the relay fee`, async function () {
      const pay = paymentFor('p2wpkh', NETWORK)
      await assert.rejects(fundAndReveal(encoding, FUNDING_RATE, [{ address: pay.address, value: 4900000 }]),
        (err) => err.xchainCode === 'REVEAL_LEGS_INSUFFICIENT' && /relay minimum/.test(err.message))
    })

    it(`${encoding} warns when a value output leaves a relayable fee below the requested rate`, async function () {
      const pay = paymentFor('p2wpkh', NETWORK)
      const result = await fundAndReveal(encoding, REVEAL_RATE, [{ address: pay.address, value: 546 }])
      const advisory = result.warnings && result.warnings.find(warning => warning.code === 'REVEAL_LEG_UNDERSIZED')
      assert.ok(advisory)
      assert.match(advisory.message, /can only pay/)
      assert.ok(result.psbt.txOutputs.some(output => Number(output.value) === 546))
    })
  }
})

// A single-chunk P2WSH reveal is funded for a stripped-floor pad output, not a sweep.
async function fundAndRevealPadded (revealRate, legValue = null) {
  const prevTxs = new Map()
  const encoder = makeEncoder(NETWORK, { estimate: 0.0002, relayfee: 0.00001, prevTxs })
  const pay = paymentFor('p2wpkh', NETWORK)
  const data = 'x'.repeat(40)
  const funding = await build(encoder, {
    utxos: [utxoFor(prevTxs, pay.output, 5000000, 'padded' + revealRate + legValue)],
    pubkey: pay.address, data, encoding: 'P2WSH', change: pay.address, feePerKb: FUNDING_RATE
  })
  const fundingTx = unsignedTx(funding)
  const leg = fundingTx.outs.find(output => output.script.length === 34 && output.script[0] === 0 && output.script[1] === 32)
  if (legValue != null) leg.value = typeof leg.value === 'bigint' ? BigInt(legValue) : legValue
  const result = await build(encoder, {
    utxos: [], pubkey: pay.address, data, encoding: 'P2WSH', change: pay.address,
    p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex(), feePerKb: revealRate
  })
  return { result, leg }
}

describe('padded single-chunk P2WSH reveal fee', function () {
  it('warns when the padded reveal is priced above its funding rate', async function () {
    const { result } = await fundAndRevealPadded(REVEAL_RATE)
    const tx = unsignedTx(result)
    assert.strictEqual(tx.ins.length, 1)
    assert.ok(tx.outs.some(output => Number(output.value) === 546), 'the stripped-floor pad must be present')
    const advisory = result.warnings && result.warnings.find(warning => warning.code === 'REVEAL_LEG_UNDERSIZED')
    assert.ok(advisory, 'a padded reveal paying less than its rate asks must carry the warning')
    assert.match(advisory.message, /can only pay \d+/)
  })

  it('stays quiet when the padded reveal uses its funding rate', async function () {
    const { result } = await fundAndRevealPadded(FUNDING_RATE)
    assert.strictEqual(unsignedTx(result).ins.length, 1)
    assert.ok(!(result.warnings || []).some(warning => warning.code === 'REVEAL_LEG_UNDERSIZED'))
  })

  it('judges an unswept reveal with a payment on the outputs it emits', async function () {
    const network = 'dogecoin-regtest'
    const prevTxs = new Map()
    const encoder = makeEncoder(network, { estimate: 0.01, relayfee: 0.001, prevTxs })
    const pay = paymentFor('p2pkh', network)
    const customOutputs = [{ address: pay.address, value: 1000000 }]
    const funding = await build(encoder, {
      utxos: [utxoFor(prevTxs, pay.output, 50000000000, 'unswept')], pubkey: pay.address, data: 'x'.repeat(40),
      encoding: 'P2SH', change: pay.address, feePerKb: 1000000, customOutputs
    })
    const fundingTx = unsignedTx(funding)
    // A fresh encoder per reveal: both rates build the same txid, which one encoder refuses to rebuild.
    const reveal = (feePerKb) => build(makeEncoder(network, { estimate: 0.01, relayfee: 0.001, prevTxs }), {
      utxos: [], pubkey: pay.address, data: 'x'.repeat(40), encoding: 'P2SH', change: pay.address,
      p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex(), feePerKb, customOutputs
    })
    const atRate = await reveal(1000000)
    assert.strictEqual(unsignedTx(atRate).outs.length, 2, 'the reveal carries the marker and the payment, no sweep')
    assert.ok(!(atRate.warnings || []).some(warning => warning.code === 'REVEAL_LEG_UNDERSIZED'))
    const doubled = await reveal(2000000)
    assert.ok((doubled.warnings || []).some(warning => warning.code === 'REVEAL_LEG_UNDERSIZED'))
  })

  it('refuses a padded reveal whose leg cannot pay the pad and the relay fee', async function () {
    for (const legValue of [556, 500]) {
      await assert.rejects(fundAndRevealPadded(FUNDING_RATE, legValue),
        (err) => err.xchainCode === 'REVEAL_LEGS_INSUFFICIENT' && /relay minimum/.test(err.message))
    }
  })
})
