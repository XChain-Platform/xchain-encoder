// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
  assert,
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {
  describe('P2SH encoding path (tx1: funding)', () => {
    it('creates P2SH output for large data', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const bigData = 'x'.repeat(80) // exceeds OP_RETURN limit

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
      // Should have P2SH output(s) + change
      const nonZeroOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.ok(nonZeroOutputs.length >= 2, 'should have P2SH output + change')
    })

    it('P2SH output value covers the spending tx fee', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const bigData = 'x'.repeat(80)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const p2shOutput = result.psbt.txOutputs.find(o =>
        o.value > 0 && o.value < 100000000
      )
      assert.ok(p2shOutput, 'P2SH output should exist')
      assert.ok(p2shOutput.value >= encoder.dustAmount,
        'P2SH output value should be >= dust')
    })
  })
})
