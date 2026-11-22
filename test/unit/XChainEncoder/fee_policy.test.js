// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// capCallerFeeRate clamps a caller rate to the tighter of the operator cap and
// the fixed 100x burn backstop, and keeps capFeePerBytes as the pure operator cap.

const assert = require('assert')
const { capCallerFeeRate, clampLimitLabel } = require('../../../src/XChainEncoder/fee_policy.js')

// 1 sat/byte expressed as coin per byte.
const ANCHOR = 1e-8
const DRAIN = ANCHOR * 500

function cap (overrides) {
  return capCallerFeeRate(Object.assign({
    feePerBytes: DRAIN, nodeFeePerBytes: ANCHOR, relayFeePerKb: 0.00001,
    maxFeePerBytes: null, maxFeeRateMultiplier: 100
  }, overrides))
}

describe('capCallerFeeRate: operator cap against the burn backstop', () => {
  it('default multiplier 100: clamps to the cap and names the cap, as before', () => {
    const r = cap({})
    assert.strictEqual(r.limit, 'cap')
    assert.strictEqual(r.clamped, true)
    assert.strictEqual(r.feePerBytes, ANCHOR * 100)
    assert.strictEqual(r.capFeePerBytes, ANCHOR * 100)
    assert.strictEqual(clampLimitLabel(r), 'the fee-rate cap')
  })

  it('multiplier 1000: the backstop binds while capFeePerBytes keeps the operator value', () => {
    const r = cap({ maxFeeRateMultiplier: 1000 })
    assert.strictEqual(r.limit, 'backstop')
    assert.strictEqual(r.feePerBytes, ANCHOR * 100)
    assert.strictEqual(r.capFeePerBytes, ANCHOR * 1000)
    assert.match(clampLimitLabel(r), /tighter than the configured fee-rate cap/)
  })

  it('loose MAX_FEE_RATE_KB with the multiplier off: the backstop binds', () => {
    const r = cap({ maxFeeRateMultiplier: null, maxFeePerBytes: ANCHOR * 1000 })
    assert.strictEqual(r.limit, 'backstop')
    assert.strictEqual(r.feePerBytes, ANCHOR * 100)
    assert.strictEqual(r.capFeePerBytes, ANCHOR * 1000)
  })

  it('MAX_FEE_RATE_KB tighter than 100x: that cap binds', () => {
    const r = cap({ maxFeeRateMultiplier: null, maxFeePerBytes: ANCHOR * 50 })
    assert.strictEqual(r.limit, 'cap')
    assert.strictEqual(r.feePerBytes, ANCHOR * 50)
  })

  it('both caps off: the backstop binds and capFeePerBytes stays null', () => {
    const r = cap({ maxFeeRateMultiplier: null })
    assert.strictEqual(r.limit, 'backstop')
    assert.strictEqual(r.capFeePerBytes, null)
    assert.strictEqual(r.feePerBytes, ANCHOR * 100)
    assert.strictEqual(clampLimitLabel(r), 'the fixed burn backstop (fee-rate cap disabled)')
  })

  it('a rate under every limit is honored unchanged', () => {
    const r = cap({ maxFeeRateMultiplier: 1000, feePerBytes: ANCHOR * 50 })
    assert.strictEqual(r.clamped, false)
    assert.strictEqual(r.feePerBytes, ANCHOR * 50)
  })

  it('no anchor and no cap: nothing to clamp against', () => {
    const r = cap({ nodeFeePerBytes: null, relayFeePerKb: 0, maxFeeRateMultiplier: null })
    assert.strictEqual(r.limit, null)
    assert.strictEqual(r.clamped, false)
    assert.strictEqual(r.feePerBytes, DRAIN)
  })
})

describe('capCallerFeeRate: a rate exactly at the limit is within it', () => {
  // An anchor of 100 sat/kB (relayfee 1e-6 coin/kB, no node estimate) puts the
  // x100 cap at 9999.999999999998 sat/kB in floats, one ULP under the 10000
  // sat/kB a caller types.
  const atCap = 10000 / 1000 / 1e8
  const base = { nodeFeePerBytes: null, relayFeePerKb: 1e-6 }

  it('multiplier cap: a caller rate exactly at the cap is not clamped', () => {
    const r = capCallerFeeRate(Object.assign({ feePerBytes: atCap, maxFeePerBytes: null, maxFeeRateMultiplier: 100 }, base))
    assert.strictEqual(r.limit, 'cap')
    assert.strictEqual(r.clamped, false)
    assert.strictEqual(r.feePerBytes, atCap)
  })

  it('fixed MAX_FEE_RATE_KB cap: a caller rate exactly at the cap is not clamped', () => {
    const r = capCallerFeeRate({ feePerBytes: atCap, nodeFeePerBytes: ANCHOR, relayFeePerKb: 1e-6, maxFeePerBytes: 10000 / 1000 / 1e8, maxFeeRateMultiplier: null })
    assert.strictEqual(r.limit, 'cap')
    assert.strictEqual(r.clamped, false)
    assert.strictEqual(r.feePerBytes, atCap)
  })

  it('backstop: a caller rate exactly at the backstop is not clamped', () => {
    const r = capCallerFeeRate(Object.assign({ feePerBytes: atCap, maxFeePerBytes: null, maxFeeRateMultiplier: 1000 }, base))
    assert.strictEqual(r.limit, 'backstop')
    assert.strictEqual(r.clamped, false)
    assert.strictEqual(r.feePerBytes, atCap)
  })

  it('a real excess still clamps to the ceiling on both limits', () => {
    const over = (10000 + 1) / 1000 / 1e8
    const c = capCallerFeeRate(Object.assign({ feePerBytes: over, maxFeePerBytes: null, maxFeeRateMultiplier: 100 }, base))
    assert.strictEqual(c.limit, 'cap')
    assert.strictEqual(c.clamped, true)
    assert.strictEqual(c.feePerBytes, 1e-6 / 1000 * 100)
    const b = capCallerFeeRate(Object.assign({ feePerBytes: over, maxFeePerBytes: null, maxFeeRateMultiplier: 1000 }, base))
    assert.strictEqual(b.limit, 'backstop')
    assert.strictEqual(b.clamped, true)
    assert.strictEqual(b.feePerBytes, 1e-6 / 1000 * 100)
  })
})
