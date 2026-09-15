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
  crypto,
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {
  describe('P2SH encoding path (tx2: spending)', () => {
    it('creates tx2 with P2SH input and OP_RETURN marker', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const bigData = 'x'.repeat(80)

      // First create tx1 to get the hex
      const tx1Result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Extract tx1 hex (unsigned, but structurally valid for our test)
      const tx1Psbt = tx1Result.psbt
      const tx1Hex = tx1Psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1Psbt.__CACHE.__TX.getId()

      // Create tx2
      const tx2Result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      assert.strictEqual(tx2Result.encoding, 'P2SH')
      // tx2 should have at least 1 input (the P2SH spend)
      assert.ok(tx2Result.psbt.data.inputs.length >= 1)
      // tx2 should have an OP_RETURN marker output
      const opReturnOutput = tx2Result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(opReturnOutput, 'tx2 should have OP_RETURN marker')
    })
  })
})
