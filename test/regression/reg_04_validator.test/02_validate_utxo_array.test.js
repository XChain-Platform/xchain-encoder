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
  validateUtxoArray,
  MAX_UTXO_COUNT
} = require('../../../src/common/validator')

const VALID_TXID = 'a'.repeat(64)

function makeValidUtxoEntry () {
  return {
    txid: VALID_TXID,
    vout: 0,
    value: 100000000,
    scriptPubKey: '0014' + 'aa'.repeat(20),
    confirmations: 6
  }
}

describe('REG-04: Validator Functions', function () {
  describe('REG-04.9: validateUtxoArray()', function () {
    it('returns null for null input', function () {
      assert.strictEqual(validateUtxoArray(null), null)
    })

    it('accepts valid array', function () {
      const result = validateUtxoArray([makeValidUtxoEntry()])
      assert.ok(Array.isArray(result))
      assert.strictEqual(result.length, 1)
    })

    it('throws TypeError for non-array', function () {
      assert.throws(() => validateUtxoArray('not-array'), { name: 'TypeError' })
    })

    it('throws RangeError for array > MAX_UTXO_COUNT entries', function () {
      const arr = Array.from({ length: MAX_UTXO_COUNT + 1 }, () => makeValidUtxoEntry())
      assert.throws(() => validateUtxoArray(arr), { name: 'RangeError' })
    })

    it('accepts array at exactly MAX_UTXO_COUNT', function () {
      const arr = Array.from({ length: MAX_UTXO_COUNT }, () => makeValidUtxoEntry())
      assert.doesNotThrow(() => validateUtxoArray(arr))
    })
  })
})
