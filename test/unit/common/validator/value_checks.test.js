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
const {
  toExactInt,
  validateOptionalBoolean,
  parseSatoshiAmount,
  firstNonLatin1
} = require('../../../../src/common/validator/value_checks')
const { MAX_SATOSHI_U64 } = require('../../../../src/common/validator/constants')

describe('validator value checks', () => {
  describe('toExactInt', () => {
    it('accepts exact integer numbers and decimal strings', () => {
      assert.strictEqual(toExactInt(5), 5)
      assert.strictEqual(toExactInt(' -7 '), -7)
    })

    it('rejects fractional and non-numeric values', () => {
      assert.ok(Number.isNaN(toExactInt(5.5)))
      assert.ok(Number.isNaN(toExactInt('1.5')))
      assert.ok(Number.isNaN(toExactInt('abc')))
      assert.ok(Number.isNaN(toExactInt(null)))
    })
  })

  describe('validateOptionalBoolean', () => {
    it('passes through omitted values and booleans', () => {
      assert.strictEqual(validateOptionalBoolean(undefined, 'enabled'), undefined)
      assert.strictEqual(validateOptionalBoolean(null, 'enabled'), undefined)
      assert.strictEqual(validateOptionalBoolean(false, 'enabled'), false)
    })

    it('rejects a string false with a precise coercion warning', () => {
      assert.throws(
        () => validateOptionalBoolean('false', 'enabled'),
        { name: 'TypeError', message: /enabled.*string "false" would coerce to true/ }
      )
    })
  })

  describe('parseSatoshiAmount', () => {
    it('returns numbers for safe integer strings and bigints', () => {
      assert.strictEqual(parseSatoshiAmount('12', 'amount'), 12)
      assert.strictEqual(parseSatoshiAmount(7n, 'amount'), 7)
    })

    it('requires allowBig for a bigint above the safe integer limit', () => {
      const value = 2n ** 60n
      assert.throws(
        () => parseSatoshiAmount(value, 'amount'),
        { name: 'RangeError', message: /exceeds the maximum safe satoshi amount/ }
      )
      assert.strictEqual(parseSatoshiAmount(value, 'amount', { allowBig: true }), value)
    })

    it('returns an exact bigint for a large decimal string with allowBig', () => {
      assert.strictEqual(
        parseSatoshiAmount('9007199254740993', 'amount', { allowBig: true }),
        9007199254740993n
      )
    })

    it('rejects negative and non-integer values', () => {
      for (const value of [-1, -5n, 'x']) {
        assert.throws(
          () => parseSatoshiAmount(value, 'amount'),
          { name: 'RangeError', message: 'amount must be a non-negative integer' }
        )
      }
    })

    it('rejects values above the unsigned 64-bit maximum', () => {
      assert.throws(
        () => parseSatoshiAmount(2n ** 64n, 'amount', { allowBig: true }),
        { name: 'RangeError', message: new RegExp(`maximum 64-bit satoshi amount \\(${MAX_SATOSHI_U64}\\)`) }
      )
    })
  })

  describe('firstNonLatin1', () => {
    it('returns minus one when every character fits in Latin-1', () => {
      assert.strictEqual(firstNonLatin1('abc'), -1)
      assert.strictEqual(firstNonLatin1(''), -1)
      assert.strictEqual(firstNonLatin1('\u00ff'), -1)
    })

    it('returns the index of the first character outside Latin-1', () => {
      assert.strictEqual(firstNonLatin1('ab\u0100'), 2)
    })
  })
})
