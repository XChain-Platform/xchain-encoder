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
const { validateChange } = require('../../../src/common/validator')

describe('REG-04: Validator Functions', function () {
  describe('REG-04.13: validateChange()', function () {
    it('returns null for null', function () {
      assert.strictEqual(validateChange(null), null)
    })

    it('accepts non-empty string <= 100 chars', function () {
      assert.strictEqual(validateChange('1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev'), '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev')
    })

    it('throws TypeError for empty string', function () {
      assert.throws(() => validateChange(''), { name: 'TypeError' })
    })

    it('throws TypeError for string > 100 chars', function () {
      assert.throws(() => validateChange('x'.repeat(101)), { name: 'TypeError' })
    })

    it('throws TypeError for non-string', function () {
      assert.throws(() => validateChange(42), { name: 'TypeError' })
    })
  })
})
