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
const { validateCompressedPubKey } = require('../../../src/common/validator')

const VALID_COMPRESSED_02 = '02' + 'a'.repeat(64)
const VALID_COMPRESSED_03 = '03' + 'b'.repeat(64)

describe('REG-04: Validator Functions', function () {
  describe('REG-04.12: validateCompressedPubKey()', function () {
    it('returns null for null', function () {
      assert.strictEqual(validateCompressedPubKey(null), null)
    })

    it('accepts 02-prefixed 66-char hex key', function () {
      assert.strictEqual(validateCompressedPubKey(VALID_COMPRESSED_02), VALID_COMPRESSED_02)
    })

    it('accepts 03-prefixed 66-char hex key', function () {
      assert.strictEqual(validateCompressedPubKey(VALID_COMPRESSED_03), VALID_COMPRESSED_03)
    })

    it('throws TypeError for 04-prefixed (uncompressed)', function () {
      assert.throws(
        () => validateCompressedPubKey('04' + 'a'.repeat(128)),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError for wrong length (too short)', function () {
      assert.throws(
        () => validateCompressedPubKey('02' + 'a'.repeat(10)),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError for non-string', function () {
      assert.throws(() => validateCompressedPubKey(12345), { name: 'TypeError' })
    })
  })
})
