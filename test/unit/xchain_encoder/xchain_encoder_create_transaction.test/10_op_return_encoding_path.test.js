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
  bitcoin,
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {
  describe('OP_RETURN encoding path', () => {
    it('auto-selects OP_RETURN for small data and returns correct encoding', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'Small', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('OP_RETURN output has value 0', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'Data', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(opReturnOutput, 'should have an OP_RETURN output with value 0')
    })

    it('OP_RETURN output script starts with OP_RETURN opcode (0x6a)', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'Data', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      assert.strictEqual(opReturnOutput.script[0], bitcoin.opcodes.OP_RETURN)
    })
  })
})
