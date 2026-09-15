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
  describe('replace-by-fee sequence', () => {
    it('sets sequence to 0xfffffffd when rbf=true (RBF armed, BIP68 still disabled)', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, true, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const inputData = result.psbt.txInputs[0]
      assert.strictEqual(inputData.sequence, 0xfffffffd)
    })

    // The literal above pins WHICH value; this pins WHY, and it is the assertion
    // that would have caught the original bug. nSequence=0x00000001 also signals
    // RBF, so every value-only test passed while the encoder was quietly enabling
    // BIP68 relative locktime of 1 block on every RBF transaction. That is
    // invisible against confirmed inputs and rejects any spend of unconfirmed
    // change as non-BIP68-final, which made RBF and chained sends mutually
    // exclusive, measured on BTC testnet4.
    it('arms RBF without enabling BIP68 relative locktime', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, true, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const seq = result.psbt.txInputs[0].sequence
      // Below 0xfffffffe: BIP125 sees this as replaceable.
      assert.ok(seq < 0xfffffffe, 'sequence ' + seq.toString(16) + ' does not signal RBF')
      // Bit 31 SET: BIP68 relative locktime is disabled, so the input carries no
      // "must be N blocks old" assertion and unconfirmed change stays spendable.
      assert.notStrictEqual(seq & 0x80000000, 0,
        'sequence ' + seq.toString(16) + ' leaves BIP68 enabled; unconfirmed change becomes unspendable')
    })

    it('sets sequence to 0xffffffff when rbf=false', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const inputData = result.psbt.txInputs[0]
      assert.strictEqual(inputData.sequence, 0xffffffff)
    })
  })
})
