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
  validateAll,
  MAX_DATA_BYTES
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
  describe('REG-04.14: validateAll() integration', function () {
    it('returns sanitized object with all fields for valid input', function () {
      const params = {
        data: 'SEND|0|JDOG|1|addr',
        rawData: null,
        pubkey: '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev',
        encoding: 'OP_RETURN',
        fee: '10000',
        feePerKb: null,
        dust: null,
        utxos: [makeValidUtxoEntry()],
        customOutputs: null,
        p2shHash: null,
        p2shHex: null,
        compressedPubKey: null,
        change: '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev',
        rbf: false,
        unconfirmed: true
      }

      const result = validateAll(params)
      assert.strictEqual(result.data, 'SEND|0|JDOG|1|addr')
      assert.strictEqual(result.encoding, 'OP_RETURN')
      assert.strictEqual(result.fee, 10000) // coerced from string
      assert.strictEqual(result.rbf, false)
      assert.strictEqual(result.unconfirmed, true)
    })

    it('throws TypeError for null params', function () {
      assert.throws(() => validateAll(null), { name: 'TypeError' })
    })

    it('throws TypeError for string params', function () {
      assert.throws(() => validateAll('not-an-object'), { name: 'TypeError' })
    })

    it('throws a SHAPE error for positional array params, not a missing-field one', function () {
      // typeof [] is 'object', so before the Array.isArray clause a JSON-RPC call
      // with positional params cleared this gate and died on 'pubkey is required'.
      assert.throws(() => validateAll([]), {
        name: 'TypeError',
        message: 'Request params must be an object'
      })
      assert.throws(() => validateAll(['SEND|0|JDOG|1|addr']), {
        name: 'TypeError',
        message: 'Request params must be an object'
      })
    })
  })
})

describe('REG-04: Validator Functions', function () {
  describe('REG-04.14: validateAll() integration', function () {
    it('throws RangeError for combined data > 65536 bytes', function () {
      assert.throws(
        () => validateAll({ data: 'x'.repeat(MAX_DATA_BYTES + 1) }),
        { name: 'RangeError' }
      )
    })

    it('rejects non-boolean rbf and unconfirmed, passes real booleans through', function () {
      // Hardened behavior: a non-boolean rbf/unconfirmed (e.g. the string
      // "false", which is truthy) would silently flip RBF signaling or unconfirmed-UTXO
      // selection on a money protocol, so validateAll rejects anything but a real JSON
      // boolean instead of coercing; undefined/null still fall through to the defaults.
      const base = { data: 'SEND|0|X|1|addr', pubkey: '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev' }
      assert.throws(() => validateAll({ ...base, rbf: 'truthy-string' }), { name: 'TypeError' })
      assert.throws(() => validateAll({ ...base, unconfirmed: 0 }), { name: 'TypeError' })
      const result = validateAll({ ...base, rbf: true, unconfirmed: false })
      assert.strictEqual(result.rbf, true)
      assert.strictEqual(result.unconfirmed, false)
    })

    it('validates P2SH pair atomically (rejects partial pair)', function () {
      assert.throws(
        () => validateAll({ data: 'SEND|0|X|1|addr', p2shHash: VALID_TXID }),
        { name: 'TypeError' }
      )
    })
  })
})
