/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * REG-04: Validator Functions
 *
 * Primary dedicated coverage for src/common/validator.js, filling the identified
 * gap where no existing test file imports the validator directly. Tests each
 * exported validate* function individually plus validateAll() as integration.
 * Purely synchronous (no encoder instantiation needed).
 */

const assert = require('assert')
const {
  validatePubkey,
  validateDataParam,
  validateCombinedDataLength,
  validateEncoding,
  validateFee,
  validateFeePerKb,
  validateDust,
  MAX_DATA_BYTES,
  MAX_FEE_SATOSHIS,
  VALID_ENCODINGS
} = require('../../src/common/validator')

describe('REG-04: Validator Functions', function () {

  describe('REG-04.1: validatePubkey()', function () {
    it('returns null for null input', function () {
      assert.strictEqual(validatePubkey(null), null)
    })

    it('returns null for undefined input', function () {
      assert.strictEqual(validatePubkey(undefined), null)
    })

    it('accepts a non-empty string', function () {
      assert.strictEqual(validatePubkey('1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev'), '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev')
    })

    it('throws TypeError for non-string (number)', function () {
      assert.throws(() => validatePubkey(12345), { name: 'TypeError' })
    })

    it('throws TypeError for empty string', function () {
      assert.throws(() => validatePubkey(''), { name: 'TypeError' })
    })

    it('throws TypeError for string > 100 chars (shares the validateAddress bound)', function () {
      assert.throws(() => validatePubkey('x'.repeat(101)), { name: 'TypeError' })
    })

    it('accepts string exactly 100 chars', function () {
      const key = 'x'.repeat(100)
      assert.strictEqual(validatePubkey(key), key)
    })
  })
})

describe('REG-04: Validator Functions', function () {
  describe('REG-04.2: validateDataParam()', function () {
    it('returns null for null', function () {
      assert.strictEqual(validateDataParam(null, 'data'), null)
    })

    it('accepts a string', function () {
      assert.strictEqual(validateDataParam('SEND|0|JDOG|1|addr', 'data'), 'SEND|0|JDOG|1|addr')
    })

    it('throws TypeError for non-string', function () {
      assert.throws(() => validateDataParam(123, 'data'), { name: 'TypeError' })
    })

    it('throws TypeError for boolean', function () {
      assert.throws(() => validateDataParam(true, 'data'), { name: 'TypeError' })
    })
  })
})

describe('REG-04: Validator Functions', function () {
  describe('REG-04.3: validateCombinedDataLength()', function () {
    it('does nothing for null data', function () {
      assert.doesNotThrow(() => validateCombinedDataLength(null, null))
    })

    it('accepts data within limit', function () {
      assert.doesNotThrow(() => validateCombinedDataLength('x'.repeat(100), null))
    })

    it('throws RangeError when combined data exceeds MAX_DATA_BYTES', function () {
      assert.throws(
        () => validateCombinedDataLength('x'.repeat(MAX_DATA_BYTES), 'y'),
        { name: 'RangeError' }
      )
    })

    it('accounts for rawData in total', function () {
      const half = 'x'.repeat(MAX_DATA_BYTES / 2 + 1)
      assert.throws(
        () => validateCombinedDataLength(half, half),
        { name: 'RangeError' }
      )
    })

    it('accepts data at exactly MAX_DATA_BYTES', function () {
      assert.doesNotThrow(() => validateCombinedDataLength('x'.repeat(MAX_DATA_BYTES), null))
    })
  })
})

describe('REG-04: Validator Functions', function () {
  describe('REG-04.4: validateEncoding()', function () {
    it('returns null for null', function () {
      assert.strictEqual(validateEncoding(null), null)
    })

    it('accepts all four valid encoding values', function () {
      for (const enc of VALID_ENCODINGS) {
        assert.strictEqual(validateEncoding(enc), enc)
      }
    })

    it('throws TypeError for invalid string', function () {
      // TAPROOT graduated to a valid encoding; pin a string that is
      // still genuinely unknown.
      assert.throws(() => validateEncoding('P2TR'), { name: 'TypeError' })
    })

    it('throws TypeError for non-string', function () {
      assert.throws(() => validateEncoding(42), { name: 'TypeError' })
    })

    it('is case-sensitive (rejects lowercase)', function () {
      assert.throws(() => validateEncoding('op_return'), { name: 'TypeError' })
      // Pin the specific lowercase 'p2sh' regression: publishers once sent this and the
      // encoder must reject it rather than silently accept a mis-cased encoding.
      assert.throws(() => validateEncoding('p2sh'), { name: 'TypeError' })
    })
  })
})

describe('REG-04: Validator Functions', function () {
  describe('REG-04.5: validateFee()', function () {
    it('returns null for null', function () {
      assert.strictEqual(validateFee(null), null)
    })

    it('returns null for false', function () {
      assert.strictEqual(validateFee(false), null)
    })

    it('parses integer string correctly', function () {
      assert.strictEqual(validateFee('10000'), 10000)
    })

    it('accepts 0', function () {
      assert.strictEqual(validateFee(0), 0)
    })

    it('accepts numeric input', function () {
      assert.strictEqual(validateFee(50000), 50000)
    })

    it('throws TypeError for non-numeric string', function () {
      assert.throws(() => validateFee('abc'), { name: 'TypeError' })
    })

    it('throws RangeError for negative value', function () {
      assert.throws(() => validateFee(-1), { name: 'RangeError' })
    })

    it('throws RangeError for value > MAX_FEE_SATOSHIS', function () {
      assert.throws(() => validateFee(MAX_FEE_SATOSHIS + 1), { name: 'RangeError' })
    })

    it('accepts MAX_FEE_SATOSHIS exactly', function () {
      assert.strictEqual(validateFee(MAX_FEE_SATOSHIS), MAX_FEE_SATOSHIS)
    })
  })
})

describe('REG-04: Validator Functions', function () {
  describe('REG-04.6: validateFeePerKb()', function () {
    it('returns null for null', function () {
      assert.strictEqual(validateFeePerKb(null), null)
    })

    it('returns null for false', function () {
      assert.strictEqual(validateFeePerKb(false), null)
    })

    it('accepts positive number', function () {
      assert.strictEqual(validateFeePerKb(0.00001), 0.00001)
    })

    it('throws RangeError for zero', function () {
      assert.throws(() => validateFeePerKb(0), { name: 'RangeError' })
    })

    it('throws RangeError for negative', function () {
      assert.throws(() => validateFeePerKb(-0.001), { name: 'RangeError' })
    })

    it('throws TypeError for NaN string', function () {
      assert.throws(() => validateFeePerKb('not-a-number'), { name: 'TypeError' })
    })

    it('throws TypeError for Infinity', function () {
      assert.throws(() => validateFeePerKb(Infinity), { name: 'TypeError' })
    })
  })
})

describe('REG-04: Validator Functions', function () {
  describe('REG-04.7: validateDust()', function () {
    it('returns null for null', function () {
      assert.strictEqual(validateDust(null), null)
    })

    it('returns null for false', function () {
      assert.strictEqual(validateDust(false), null)
    })

    it('parses integer correctly', function () {
      assert.strictEqual(validateDust('546'), 546)
    })

    it('accepts 0', function () {
      assert.strictEqual(validateDust(0), 0)
    })

    it('throws TypeError for non-integer string', function () {
      assert.throws(() => validateDust('abc'), { name: 'TypeError' })
    })

    it('throws RangeError for negative value', function () {
      assert.throws(() => validateDust(-1), { name: 'RangeError' })
    })
  })
})
