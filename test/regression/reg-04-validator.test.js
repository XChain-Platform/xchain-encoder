/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * REG-04: Validator Functions
 *
 * Primary dedicated coverage for src/validator.js — filling the identified
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
  validateUtxoArray,
  validateUtxoEntry,
  validateCustomOutputs,
  validateP2shParams,
  validateCompressedPubKey,
  validateChange,
  validateAll,
  MAX_DATA_BYTES,
  MAX_UTXO_COUNT,
  MAX_CUSTOM_OUTPUTS,
  MAX_FEE_SATOSHIS,
  VALID_ENCODINGS
} = require('../../src/validator')

const VALID_TXID = 'a'.repeat(64)
const VALID_COMPRESSED_02 = '02' + 'a'.repeat(64)
const VALID_COMPRESSED_03 = '03' + 'b'.repeat(64)

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

  // ── REG-04.1: validatePubkey ──────────────────────────────────

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

    it('throws TypeError for string > 200 chars', function () {
      assert.throws(() => validatePubkey('x'.repeat(201)), { name: 'TypeError' })
    })

    it('accepts string exactly 200 chars', function () {
      const key = 'x'.repeat(200)
      assert.strictEqual(validatePubkey(key), key)
    })
  })

  // ── REG-04.2: validateDataParam ───────────────────────────────

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

  // ── REG-04.3: validateCombinedDataLength ──────────────────────

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

  // ── REG-04.4: validateEncoding ────────────────────────────────

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
      assert.throws(() => validateEncoding('TAPROOT'), { name: 'TypeError' })
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

  // ── REG-04.5: validateFee ─────────────────────────────────────

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

  // ── REG-04.6: validateFeePerKb ────────────────────────────────

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

  // ── REG-04.7: validateDust ────────────────────────────────────

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

  // ── REG-04.8: validateUtxoEntry ───────────────────────────────

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

  // ── REG-04.9: validateUtxoArray ───────────────────────────────

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

  // ── REG-04.10: validateCustomOutputs ──────────────────────────

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

  // ── REG-04.11: validateP2shParams ─────────────────────────────

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

  // ── REG-04.12: validateCompressedPubKey ───────────────────────

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

  // ── REG-04.13: validateChange ─────────────────────────────────

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

  // ── REG-04.14: validateAll() integration ──────────────────────

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

    it('throws RangeError for combined data > 65536 bytes', function () {
      assert.throws(
        () => validateAll({ data: 'x'.repeat(MAX_DATA_BYTES + 1) }),
        { name: 'RangeError' }
      )
    })

    it('passes through rbf and unconfirmed without coercion', function () {
      const result = validateAll({
        data: 'SEND|0|X|1|addr',
        rbf: 'truthy-string',
        unconfirmed: 0
      })
      assert.strictEqual(result.rbf, 'truthy-string')
      assert.strictEqual(result.unconfirmed, 0)
    })

    it('validates P2SH pair atomically (rejects partial pair)', function () {
      assert.throws(
        () => validateAll({ data: 'SEND|0|X|1|addr', p2shHash: VALID_TXID }),
        { name: 'TypeError' }
      )
    })
  })
})
