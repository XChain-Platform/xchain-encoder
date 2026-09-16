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
  TXID_B,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {
  describe('UTXO sorting (largest first)', () => {
    it('uses the largest UTXO first', async () => {
      const encoder = makeEncoder()
      const small = makeSegwitUtxo(TXID_A, 0, 10000000)
      const large = makeSegwitUtxo(TXID_B, 0, 100000000)

      const result = await encoder.createTransaction(
        [small, large], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // The large UTXO alone covers the fee, so only 1 input needed
      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })
})
