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

async function fundAndReveal (encoding, revealRate) {
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
    p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex(), feePerKb: revealRate
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
  }
})
