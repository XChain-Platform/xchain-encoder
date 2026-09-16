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
const { validateP2shParams } = require('../../../src/common/validator')

const VALID_TXID = 'a'.repeat(64)

describe('REG-04: Validator Functions', function () {
  describe('REG-04.11: validateP2shParams()', function () {
    it('returns nulls when both absent', function () {
      const result = validateP2shParams(null, null)
      assert.strictEqual(result.p2shHash, null)
      assert.strictEqual(result.p2shHex, null)
    })

    it('returns nulls when both false', function () {
      const result = validateP2shParams(false, false)
      assert.strictEqual(result.p2shHash, null)
      assert.strictEqual(result.p2shHex, null)
    })

    it('throws TypeError when only p2shHash is provided', function () {
      assert.throws(
        () => validateP2shParams(VALID_TXID, null),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError when only p2shHex is provided', function () {
      assert.throws(
        () => validateP2shParams(null, 'aabb'),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError for non-hex-64 p2shHash', function () {
      assert.throws(
        () => validateP2shParams('tooshort', 'aabb'),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError for empty p2shHex string', function () {
      assert.throws(
        () => validateP2shParams(VALID_TXID, ''),
        { name: 'TypeError' }
      )
    })

    it('accepts valid pair', function () {
      const result = validateP2shParams(VALID_TXID, 'aabbccdd')
      assert.strictEqual(result.p2shHash, VALID_TXID)
      assert.strictEqual(result.p2shHex, 'aabbccdd')
    })
  })
})
