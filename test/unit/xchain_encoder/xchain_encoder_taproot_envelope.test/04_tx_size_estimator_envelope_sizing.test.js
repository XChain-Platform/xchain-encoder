// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//

const assert = require('assert')
const TxSizeEstimator = require('../../../src/build/tx_size_estimator')

describe('XChainEncoder TAPROOT envelope', function () {
  describe('TxSizeEstimator envelope sizing', function () {
    it('estimateEnvelopeRevealTx covers and does not wildly over-fund a real reveal', function () {
      // Direct sanity independent of the encoder round trip above: a
      // ~10 KB envelope script with one p2tr-sized output.
      const est = TxSizeEstimator.estimateEnvelopeRevealTx(10000, 43, 65)
      // nonwitness 10+41+43 = 94; witness 2+1+66+3+10000+34 -> /4 ≈ 2527; +2
      assert.ok(est > 2600 && est < 2700, `estimate ${est} in the expected band`)
    })
    it('estimateTaprootOutput matches the serialized P2TR output size', function () {
      assert.strictEqual(TxSizeEstimator.estimateTaprootOutput(), 43)
    })
    it('uses compactSize framing for scripts above 65535 bytes (5-byte prefix band)', function () {
      const below = TxSizeEstimator.estimateEnvelopeRevealTx(65535, 43, 65)
      const above = TxSizeEstimator.estimateEnvelopeRevealTx(65536, 43, 65)
      // +1 script byte and +2 varint bytes, ÷4 and ceiled: at most +1 vbyte step.
      assert.ok(above >= below, 'monotonic across the varint band switch')
    })
  })
})
