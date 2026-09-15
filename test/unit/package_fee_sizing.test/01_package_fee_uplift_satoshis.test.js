// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const XChainEncoder = require('../../../src/XChainEncoder')

const SATOSHI_UNIT = 100000000

describe('packageFeeUpliftSatoshis() @regression @tier1', () => {

  const uplift = (o) => XChainEncoder.packageFeeUpliftSatoshis(Object.assign({ satoshiUnit: SATOSHI_UNIT }, o))

  it('reproduces the live DOGE shortfall', () => {
    // 2000 bytes of ancestors paying 0.00313 DOGE/kB, a 1000-byte child, a
    // 0.01 DOGE/kB target: the package needs 0.03 DOGE and the ancestors bring
    // 0.00626, so the child owes 0.02374 DOGE (2,374,000 koinu).
    const owed = uplift({
      currentFee: 0,
      txSize: 1000,
      ancestorSize: 2000,
      ancestorFees: 0.00626,
      targetFeePerBytes: 0.01 / 1000
    })
    assert.strictEqual(owed, 2374000)
    const packageRate = (626000 + owed) / 3000 * 1000 / SATOSHI_UNIT
    assert.ok(packageRate >= 0.01, 'the uplifted package must clear the inclusion floor, got ' + packageRate)
  })

  it('subtracts what the transaction already pays', () => {
    const owed = uplift({
      currentFee: 1000000,
      txSize: 1000,
      ancestorSize: 2000,
      ancestorFees: 0.00626,
      targetFeePerBytes: 0.01 / 1000
    })
    assert.strictEqual(owed, 1374000)
  })

  it('returns 0 when the package already clears the target', () => {
    assert.strictEqual(uplift({
      currentFee: 500000,
      txSize: 250,
      ancestorSize: 500,
      ancestorFees: 0.05,
      targetFeePerBytes: 0.01 / 1000
    }), 0, 'a rich ancestor must never LOWER this fee')
  })

})

describe('packageFeeUpliftSatoshis() @regression @tier1', () => {

  const uplift = (o) => XChainEncoder.packageFeeUpliftSatoshis(Object.assign({ satoshiUnit: SATOSHI_UNIT }, o))

  it('takes the ancestor fee in base units when one is given, ahead of the coin-unit figure', () => {
    // The two-phase prefund knows the commit's fee exactly, as an integer. A
    // coin-unit round trip would reintroduce the float error the ceiling shaves.
    const owed = uplift({
      currentFee: 0,
      txSize: 1000,
      ancestorSize: 2000,
      ancestorFees: 1,                  // a wildly different coin-unit figure
      ancestorFeeSatoshis: 626000,
      targetFeePerBytes: 0.01 / 1000
    })
    assert.strictEqual(owed, 2374000, 'the base-unit figure wins')
  })

  it('returns 0 for an empty package or a missing target', () => {
    const base = { currentFee: 0, txSize: 250, ancestorSize: 0, ancestorFees: 0, targetFeePerBytes: 0.00001 }
    assert.strictEqual(uplift(base), 0)
    assert.strictEqual(uplift(Object.assign({}, base, { ancestorSize: 1000, targetFeePerBytes: 0 })), 0)
    assert.strictEqual(uplift(Object.assign({}, base, { ancestorSize: 1000, txSize: 0 })), 0)
    assert.strictEqual(uplift(Object.assign({}, base, { ancestorSize: NaN })), 0)
  })

})

