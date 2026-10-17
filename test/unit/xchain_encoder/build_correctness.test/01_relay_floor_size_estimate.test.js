// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The single-transaction size estimate has to count the 10-byte header and, with a
// segwit input, the marker and flag. Without them a many-input build at the relay
// floor paid a few satoshis under 1 sat/vB and the node refused it.

'use strict'

const assert = require('assert')
const F = require('./helpers/build_fixture')

async function buildSegwitSpend (coin, inputCount, feePerKb, encoderOver) {
  const utxos = []
  for (let i = 0; i < inputCount; i++) utxos.push(F.makeUtxo(coin, 'p2wpkh', 100000))
  const res = await F.create(F.makeEncoder(coin, encoderOver), {
    utxos, pubkey: F.p2pkhAddr(coin), data: 'BROADCAST|0|0|x', encoding: 'OP_RETURN', change: F.p2wshAddr(coin),
    customOutputs: [{ address: F.p2wshAddr(coin), value: 100000 * inputCount - 60000 }], feePerKb
  })
  return F.account(res.psbt)
}

describe('single-transaction size estimate covers the header and segwit marker', () => {
  // LTC's 5460-litoshi fee floor masks the undercount at 1 lit/vB, so it is measured at 5.
  const cases = [['btc', 10, 1000], ['btc', 20, 1000], ['ltc', 20, 5000]]
  for (const [coin, inputCount, feePerKb] of cases) {
    it(`${coin}: ${inputCount} P2WPKH inputs at ${feePerKb / 1000} sat/vB pay the rate on the real vsize`, async () => {
      const a = await buildSegwitSpend(coin, inputCount, feePerKb)
      assert.strictEqual(a.ins, a.outs + a.fee, 'value is conserved')
      assert.ok(Number(a.fee) >= a.vsize * feePerKb / 1000, `fee ${a.fee} is under ${a.vsize} vB at ${feePerKb / 1000} sat/vB`)
    })
  }

  it('a node estimate under the relay floor is lifted to the floor rather than built under it', async () => {
    // 0.5 sat/vB quoted by the node against a 1 sat/vB relayfee.
    const a = await buildSegwitSpend('btc', 20, null, { est: 0.000005 })
    assert.ok(Number(a.fee) >= a.vsize, `fee ${a.fee} is under ${a.vsize} vB at the relay floor`)
  })
})
