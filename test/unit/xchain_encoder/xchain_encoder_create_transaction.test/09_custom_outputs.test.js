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
  describe('custom outputs', () => {
    it('adds custom outputs with correct address and value', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const customOutputs = [
        { address: TEST_ADDRESS, value: '500000' },
        { address: TEST_ADDRESS, value: '300000' }
      ]

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, customOutputs,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Should have: OP_RETURN (0 value) + 2 custom + 1 change = 4 outputs
      const outputs = result.psbt.txOutputs
      const customValues = outputs.filter(o =>
        o.value === 500000 || o.value === 300000
      )
      assert.strictEqual(customValues.length, 2)
    })

    it('skips custom outputs when customOutputs is not an array', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Pass an object (not array); should be silently skipped
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, { address: TEST_ADDRESS, value: 1000 },
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Should only have OP_RETURN + change = 2 outputs
      assert.strictEqual(result.psbt.txOutputs.length, 2)
    })

    it('skips custom outputs when customOutputs is null', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txOutputs.length, 2)
    })
  })
})
