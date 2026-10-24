// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A single-chunk P2WSH reveal sits under the stripped-size floor and carries one pad
// output to clear it. The funding leg has to price that output's bytes; flooring the
// estimate at the floor alone left the reveal several sat/vB under the asked rate.

'use strict'

const assert = require('assert')
const F = require('./helpers/build_fixture')
const TxSizeEstimator = require('../../../../src/build/tx_size_estimator')
const { feeForVsize } = require('../../../../src/XChainEncoder/fee_policy.js')
const { SATOSHI_UNIT } = require('../../../../src/XChainEncoder/constants.js')

async function revealAt (coin, feePerKb, payloadLength, change) {
  const data = 'BROADCAST|0|0|' + 'w'.repeat(payloadLength - 14)
  const funding = await F.create(F.makeEncoder(coin), {
    utxos: [F.makeUtxo(coin, 'p2wpkh', 5000000)], pubkey: F.p2pkhAddr(coin), data, encoding: 'P2WSH', change, feePerKb
  })
  const fundingTx = F.account(funding.psbt).tx
  const reveal = await F.create(F.makeEncoder(coin), {
    pubkey: F.p2pkhAddr(coin), data, encoding: 'P2WSH', change, feePerKb, p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex()
  })
  return { a: F.account(reveal.psbt), outputs: reveal.psbt.txOutputs.length }
}

describe('P2WSH reveal funding prices the stripped-size pad output', () => {
  for (const coin of ['btc', 'ltc']) {
    for (const feePerKb of [10000, 50000, 100000]) {
      for (const payloadLength of [30, 470]) {
        it(`${coin}: a ${payloadLength}-byte single-chunk reveal at ${feePerKb / 1000} sat/vB pays the rate`, async () => {
          const { a, outputs } = await revealAt(coin, feePerKb, payloadLength, F.p2pkhAddr(coin))
          assert.strictEqual(outputs, 2, 'the marker and the pad output')
          assert.ok(a.stripped >= F.net(coin).minStandardTxNonWitnessSize, 'the pad clears the stripped floor')
          const rate = Number(a.fee) / a.vsize
          assert.ok(rate >= feePerKb / 1000, `reveal pays ${rate.toFixed(3)} sat/vB of ${feePerKb / 1000}`)
        })
      }
    }
  }

  it('with no change address the pad is priced at the largest standard output', async () => {
    const encoder = F.makeEncoder('btc')
    const bare = encoder.estimateSpendingP2wshTx(Buffer.alloc(40), 34)
    const worst = encoder.estimateSpendingP2wshTx(Buffer.alloc(40))
    assert.strictEqual(worst - bare, 43 - 34)
  })
})

// A caller output on the reveal already lifts a single-chunk reveal over the stripped
// floor, so the reveal emits no pad. The commit must then not prefund one either:
// a pad funded but never emitted, with no surplus sweep to return it, was paid to
// the miner and doubled the reveal's fee.
describe('a single-chunk P2WSH reveal with a caller output funds no unused pad', () => {
  const PAID = 100000
  for (const coin of ['btc', 'ltc']) {
    for (const feePerKb of [1000, 10000, 100000]) {
      it(`${coin}: at ${feePerKb / 1000} sat/vB the reveal pays its own fee and returns any surplus`, async () => {
        const encoder = F.makeEncoder(coin)
        const data = 'BROADCAST|0|0|' + 'w'.repeat(30 - 14)
        const customOutputs = [{ address: F.otherAddr(coin), value: PAID }]
        const change = F.p2pkhAddr(coin)
        const common = { pubkey: F.p2pkhAddr(coin), data, encoding: 'P2WSH', change, feePerKb, customOutputs }
        const funding = await F.create(encoder, { ...common, utxos: [F.makeUtxo(coin, 'p2wpkh', 5000000)] })
        const fundingTx = F.account(funding.psbt).tx
        const reveal = await F.create(F.makeEncoder(coin), { ...common, p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex() })
        const a = F.account(reveal.psbt)
        const outs = reveal.psbt.txOutputs

        assert.strictEqual(reveal.psbt.inputCount, 1, 'one data chunk')
        assert.ok(a.stripped >= F.net(coin).minStandardTxNonWitnessSize, 'the caller output clears the stripped floor')
        assert.ok(outs.some((o) => o.address === customOutputs[0].address && o.value === PAID), 'the caller output is paid')
        const rate = Number(a.fee) / a.vsize
        assert.ok(rate >= feePerKb / 1000, `reveal pays ${rate.toFixed(3)} sat/vB of ${feePerKb / 1000}`)

        // The fee the encoder's own reveal math keeps: the asked rate over its reveal size
        // estimate (worst-case change slot plus the caller output), floored at dust.
        const chunks = reveal.psbt.data.inputs.map((i) => i.witnessScript)
        const callerBytes = TxSizeEstimator.estimateOutputSizeForAddress(customOutputs[0].address, F.net(coin))
        const owedSize = encoder.estimateP2wshRevealTx(chunks, 43 + callerBytes)
        const owed = Math.max(feeForVsize(owedSize, feePerKb / 1000 / SATOSHI_UNIT, SATOSHI_UNIT), encoder.dustAmount)
        assert.ok(Number(a.fee) - owed < encoder.outputFloor,
          `reveal fee ${a.fee} exceeds the owed ${owed} by ${Number(a.fee) - owed}, at or above the ${encoder.outputFloor} output floor`)

        // Conservation: every output beyond the marker and the caller's own is a sweep at or
        // above the floor, and whatever was not swept is under the floor.
        const extra = outs.filter((o) => o.value > 0 && !(o.address === customOutputs[0].address && o.value === PAID))
        for (const o of extra) assert.ok(o.value >= encoder.outputFloor, `output ${o.value} is under the floor`)
        assert.ok(a.ins - BigInt(PAID) - BigInt(owed) - extra.reduce((s, o) => s + BigInt(o.value), 0n) < BigInt(encoder.outputFloor),
          'leg value left after the owed fee and every output stays under the output floor')
      })
    }
  }
})
