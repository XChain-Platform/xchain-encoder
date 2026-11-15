// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The fixed burn backstop and the default relative fee cap are separate literals
// that must agree: a default deployment never reaches the backstop, and a deployment
// that turns the relative cap off still gets the same 100x ceiling the docs describe.

const assert = require('assert')
const {
  DEFAULT_MAX_FEE_RATE_MULTIPLIER,
  BURN_BACKSTOP_MULTIPLIER
} = require('../../../src/XChainEncoder/constants.js')

describe('fee multiplier constants', () => {
  it('keeps the burn backstop equal to the default relative fee-rate cap', () => {
    assert.strictEqual(BURN_BACKSTOP_MULTIPLIER, DEFAULT_MAX_FEE_RATE_MULTIPLIER)
  })

  it('keeps both multipliers positive finite numbers', () => {
    for (const value of [DEFAULT_MAX_FEE_RATE_MULTIPLIER, BURN_BACKSTOP_MULTIPLIER]) {
      assert.ok(Number.isFinite(value) && value > 0, String(value))
    }
  })
})
