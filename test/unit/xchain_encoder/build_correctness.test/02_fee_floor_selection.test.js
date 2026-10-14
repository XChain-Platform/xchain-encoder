// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The fee is floored at the coin's dust threshold, and input selection has to aim at
// that floored fee. Selecting against the unfloored fee stopped one input short and a
// fundable spend failed with insufficient funds.

'use strict'

const assert = require('assert')
const F = require('./helpers/build_fixture')

function twoInputSpend (coin, kind, a, b, pay, extra) {
  return F.create(F.makeEncoder(coin, extra.encoderOver), {
    utxos: [F.makeUtxo(coin, kind, a), F.makeUtxo(coin, kind, b)], pubkey: F.p2pkhAddr(coin),
    data: 'BROADCAST|0|0|x', encoding: 'OP_RETURN', change: F.p2pkhAddr(coin),
    customOutputs: [{ address: F.otherAddr(coin), value: pay }], fee: extra.fee, feePerKb: extra.feePerKb
  })
}

describe('input selection targets the floored fee', () => {
  const cases = [
    { label: 'btc caller rate 1 sat/vB', coin: 'btc', kind: 'p2wpkh', a: 10000, b: 5000, pay: 9600, feePerKb: 1000 },
    { label: 'btc explicit fee under the dust floor', coin: 'btc', kind: 'p2wpkh', a: 10000, b: 5000, pay: 9500, fee: 300 },
    { label: 'ltc caller rate 1 lit/vB', coin: 'ltc', kind: 'p2wpkh', a: 100000, b: 50000, pay: 99000, feePerKb: 1000 },
    { label: 'ltc node estimate of 2 lit/vB', coin: 'ltc', kind: 'p2wpkh', a: 100000, b: 50000, pay: 99000, encoderOver: { est: 0.00002 } },
    { label: 'doge caller rate at the relay floor', coin: 'doge', kind: 'p2pkh', a: 5000000, b: 3000000, pay: 4950000, feePerKb: 100000 }
  ]
  for (const c of cases) {
    it(`${c.label}: a spend the two inputs fund builds with both`, async () => {
      const res = await twoInputSpend(c.coin, c.kind, c.a, c.b, c.pay, c)
      const a = F.account(res.psbt)
      assert.strictEqual(res.psbt.inputCount, 2)
      assert.strictEqual(a.ins, a.outs + a.fee, 'value is conserved')
      assert.ok(Number(a.fee) >= F.makeEncoder(c.coin).dustAmount, 'the fee is at least the dust floor')
    })
  }

  it('an unfundable spend names the fee the build needs and the fee that was requested', async () => {
    let caught = null
    try {
      await F.create(F.makeEncoder('btc'), {
        utxos: [F.makeUtxo('btc', 'p2wpkh', 10000)], pubkey: F.p2pkhAddr('btc'), data: 'BROADCAST|0|0|x',
        encoding: 'OP_RETURN', change: F.p2pkhAddr('btc'), customOutputs: [{ address: F.otherAddr('btc'), value: 9500 }], fee: 300
      })
    } catch (err) { caught = err }
    assert.ok(caught, 'the build is refused')
    assert.strictEqual(caught.xchainCode, 'INSUFFICIENT_FUNDS')
    assert.strictEqual(caught.details.fee, 546)
    assert.strictEqual(caught.details.requestedFee, 300)
    assert.match(caught.message, /fee 546/)
    assert.match(caught.message, /requested fee 300/)
  })
})
