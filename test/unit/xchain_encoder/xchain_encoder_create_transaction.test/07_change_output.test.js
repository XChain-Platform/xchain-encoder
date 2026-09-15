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
  describe('change output', () => {
    it('adds change output when there is leftover and change address given', async () => {
      const encoder = makeEncoder()
      // Isolate the change math from the network dust floor so the 10000 custom fee
      // flows into change verbatim (the dust floor has its own suite).
      encoder.dustAmount = 546
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.ok(changeOutput, 'change output should exist')
      assert.strictEqual(changeOutput.value, 100000000 - 10000)
    })

    it('throws when change address is falsy and change would be burned', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], TEST_ADDRESS, null,
          'test', null, 10000, false, null, null, // no change address
          null, null, null, true, 0.00001
        ),
        /change address/i
      )
    })
  })
})
