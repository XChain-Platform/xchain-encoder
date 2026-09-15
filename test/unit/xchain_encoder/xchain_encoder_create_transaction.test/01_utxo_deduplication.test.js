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
  describe('UTXO deduplication', () => {
    it('removes duplicate UTXOs with same txid+vout', async () => {
      const encoder = makeEncoder()
      const dup1 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const dup2 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const unique = makeSegwitUtxo(TXID_B, 1, 30000000)

      const result = await encoder.createTransaction(
        [dup1, dup2, unique], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt.data.inputs.length <= 2)
    })
  })
})
