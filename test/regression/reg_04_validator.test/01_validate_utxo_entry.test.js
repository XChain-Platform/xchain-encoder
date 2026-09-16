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
const { validateUtxoEntry } = require('../../../src/common/validator')

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
  describe('REG-04.8: validateUtxoEntry()', function () {
    it('validates a complete valid entry and coerces value/vout', function () {
      const entry = {
        txid: VALID_TXID,
        vout: '0',
        value: '100000000',
        scriptPubKey: '0014aabb'
      }
      const result = validateUtxoEntry(entry, 0)
      assert.strictEqual(result.vout, 0)
      assert.strictEqual(result.value, 100000000)
      assert.strictEqual(result.confirmations, 0) // default
    })

    it('throws TypeError for non-object', function () {
      assert.throws(() => validateUtxoEntry('string', 0), { name: 'TypeError' })
    })

    it('throws TypeError for array', function () {
      assert.throws(() => validateUtxoEntry([1, 2, 3], 0), { name: 'TypeError' })
    })

    it('throws TypeError for txid that is not 64-char hex', function () {
      assert.throws(
        () => validateUtxoEntry({ txid: 'short', vout: 0, value: 100, scriptPubKey: 'aa' }, 0),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError for txid with non-hex chars', function () {
      assert.throws(
        () => validateUtxoEntry({ txid: 'g'.repeat(64), vout: 0, value: 100, scriptPubKey: 'aa' }, 0),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError for negative vout', function () {
      assert.throws(
        () => validateUtxoEntry({ txid: VALID_TXID, vout: -1, value: 100, scriptPubKey: 'aa' }, 0),
        { name: 'TypeError' }
      )
    })
  })
})

describe('REG-04: Validator Functions', function () {
  describe('REG-04.8: validateUtxoEntry()', function () {
    it('throws RangeError for negative value', function () {
      assert.throws(
        () => validateUtxoEntry({ txid: VALID_TXID, vout: 0, value: -1, scriptPubKey: 'aa' }, 0),
        { name: 'RangeError' }
      )
    })

    it('throws TypeError for missing scriptPubKey', function () {
      assert.throws(
        () => validateUtxoEntry({ txid: VALID_TXID, vout: 0, value: 100 }, 0),
        { name: 'TypeError' }
      )
    })

    it('throws TypeError for empty scriptPubKey', function () {
      assert.throws(
        () => validateUtxoEntry({ txid: VALID_TXID, vout: 0, value: 100, scriptPubKey: '' }, 0),
        { name: 'TypeError' }
      )
    })

    it('sets confirmations=0 when absent', function () {
      const entry = makeValidUtxoEntry()
      delete entry.confirmations
      validateUtxoEntry(entry, 0)
      assert.strictEqual(entry.confirmations, 0)
    })

    it('preserves existing confirmations', function () {
      const entry = makeValidUtxoEntry()
      entry.confirmations = 10
      validateUtxoEntry(entry, 0)
      assert.strictEqual(entry.confirmations, 10)
    })
  })
})
