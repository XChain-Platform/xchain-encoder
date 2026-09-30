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
  pubkeyBuf,
  TXID_A,
  TXID_MS,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {
  describe('custom dust parameter', () => {
    it('overrides finalDust for MULTISIGN output value when it raises the floor', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')
      // Above the LTC output floor (5460), so the caller's value is honoured.
      const customDust = 6000
      assert.ok(customDust > encoder.outputFloor)

      const MS_DATA = 'A'.repeat(59)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey,
        true, 0.00001, customDust
      )

      const msOutput = result.psbt.txOutputs.find(o => o.value === customDust)
      assert.ok(msOutput, 'MULTISIGN output should use custom dust value of 6000')
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('custom dust parameter', () => {
    it('clamps a caller dust below the output floor up to the floor', async () => {
      // 1234 litoshi is under LTC's 5460 dust threshold: an output that size is
      // non-standard and the whole transaction unrelayable, so a caller may
      // raise the floor but never lower it.
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')
      const customDust = 1234
      assert.ok(customDust < encoder.outputFloor)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'A'.repeat(59), null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey,
        true, 0.00001, customDust
      )

      assert.ok(!result.psbt.txOutputs.find(o => o.value === customDust), 'no output at the sub-floor value')
      assert.ok(result.psbt.txOutputs.find(o => o.value === encoder.outputFloor), 'the data output sits at the floor')
    })

    it('does NOT override the fee floor (fee floor uses this.dustAmount)', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Pass custom dust smaller than network dustAmount
      // Fee floor should still use this.dustAmount (546), not the custom dust
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, null, false, null, TEST_ADDRESS,
        null, null, null,
        true, null, 100 // custom dust = 100, but network dust = 546
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= network dustAmount ${encoder.dustAmount}`)
    })
  })
})
