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
  describe('unconfirmed filtering', () => {
    it('excludes mempool UTXOs when unconfirmed=false', async () => {
      const encoder = makeEncoder()
      const confirmed = makeSegwitUtxo(TXID_A, 0, 100000000)
      confirmed.confirmations = 6
      const mempool = makeSegwitUtxo(TXID_B, 0, 50000000)
      mempool.confirmations = 0

      const result = await encoder.createTransaction(
        [mempool, confirmed], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, false, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })

    it('keeps mempool UTXOs when unconfirmed=true', async () => {
      const encoder = makeEncoder()
      const mempool = makeSegwitUtxo(TXID_A, 0, 100000000)
      mempool.confirmations = 0

      const result = await encoder.createTransaction(
        [mempool], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })
})
