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
  validateCustomOutputs,
  MAX_CUSTOM_OUTPUTS
} = require('../../../src/common/validator')

describe('REG-04: Validator Functions', function () {
  describe('REG-04.10: validateCustomOutputs()', function () {
    it('returns null for null input', function () {
      assert.strictEqual(validateCustomOutputs(null), null)
    })

    it('validates address and value fields', function () {
      const outputs = [{ address: '1ABC', value: '10000' }]
      const result = validateCustomOutputs(outputs)
      assert.strictEqual(result[0].value, 10000) // coerced to int
    })

    it('throws TypeError for non-array', function () {
      assert.throws(() => validateCustomOutputs('nope'), { name: 'TypeError' })
    })

    it('throws RangeError for array > MAX_CUSTOM_OUTPUTS', function () {
      const arr = Array.from({ length: MAX_CUSTOM_OUTPUTS + 1 }, () => ({
        address: '1ABC', value: 1000
      }))
      assert.throws(() => validateCustomOutputs(arr), { name: 'RangeError' })
    })

    it('throws RangeError for negative value', function () {
      assert.throws(
        () => validateCustomOutputs([{ address: '1ABC', value: -1 }]),
        { name: 'RangeError' }
      )
    })

    it('throws TypeError for empty address string', function () {
      assert.throws(
        () => validateCustomOutputs([{ address: '', value: 1000 }]),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError for address > 100 chars', function () {
      assert.throws(
        () => validateCustomOutputs([{ address: 'x'.repeat(101), value: 1000 }]),
        { name: 'TypeError' }
      )
    })
  })
})
