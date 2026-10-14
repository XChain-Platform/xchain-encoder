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
