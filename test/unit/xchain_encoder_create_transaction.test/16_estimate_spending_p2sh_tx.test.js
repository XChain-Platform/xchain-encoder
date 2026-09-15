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
  makeEncoder,
  TxSizeEstimator
} = require('./fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {
  describe('estimateSpendingP2shTx()', () => {
    it('returns 10 + P2SH input + OP_RETURN + 8-byte safety margin', () => {
      const encoder = makeEncoder()
      const redeemData = Buffer.alloc(200, 0xAA)

      const expected = 10
        + TxSizeEstimator.estimateP2shInputWithRedeem(redeemData)
        + TxSizeEstimator.estimateOpReturnOutput(
            Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2sh')])
          )
        + 8 // safety margin for DER-sig length jitter

      assert.strictEqual(encoder.estimateSpendingP2shTx(redeemData), expected)
    })

    it('increases monotonically with redeem data size', () => {
      const encoder = makeEncoder()
      const small = encoder.estimateSpendingP2shTx(Buffer.alloc(100))
      const large = encoder.estimateSpendingP2shTx(Buffer.alloc(400))
      assert.ok(large > small)
      // Delta is at least the raw data delta (300); the larger redeem may
      // cross the OP_PUSHDATA2 (256) and scriptSig-varint (253) boundaries,
      // each adding bytes, so we assert monotonicity, not exact equality.
      assert.ok(large - small >= 300)
    })
  })
})
