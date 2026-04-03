/**
 * Data/Payload Boundary Tests
 *
 * Tests edge cases in the `data` and `rawData` parameters: UTF-8 multi-byte
 * characters hitting byte-level encoding boundaries, null bytes in data,
 * empty data strings, and rawData presence affecting compiled script size.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const {
  extractOpReturnPayload,
  decompilePayload,
  MAGIC_WORD
} = require('../integration/helpers/deobfuscate')

const NETWORK = 'dogecoin-regtest'

function standardUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

describe('Data/Payload Boundaries', () => {

  // ── UTF-8 multi-byte at byte boundary ───────────────────────────

  describe('UTF-8 multi-byte at byte boundary', () => {
    it('75-byte UTF-8 string (37 two-byte chars + 1 ASCII) → OP_RETURN', async () => {
      // \u00e9 (é) is 2 bytes in UTF-8. 37 * 2 + 1 = 75 bytes.
      // compile([75-byte buf]) = 76 bytes. 76 + 4 magic = 80 ≤ 80 → OP_RETURN
      const data = '\u00e9'.repeat(37) + 'A'
      assert.strictEqual(Buffer.byteLength(data, 'utf8'), 75)

      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('76-byte UTF-8 string (38 two-byte chars) → P2SH', async () => {
      // 38 * 2 = 76 bytes. compile([76-byte buf]) = 78 bytes. 78 + 4 = 82 > 80 → P2SH
      const data = '\u00e9'.repeat(38)
      assert.strictEqual(Buffer.byteLength(data, 'utf8'), 76)
      assert.strictEqual(data.length, 38, 'char count differs from byte count')

      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })
  })

  // ── Empty data string ───────────────────────────────────────────

  describe('empty data string', () => {
    it('data="" → OP_RETURN with 1 output', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        '', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
      const opReturnOutputs = result.psbt.txOutputs.filter(o => o.value === 0)
      assert.strictEqual(opReturnOutputs.length, 1)
    })

    it('deobfuscated empty-data payload has MAGIC_WORD', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        '', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })
  })

  // ── rawData parameter ───────────────────────────────────────────

  describe('rawData parameter interactions', () => {
    it('rawData=null: decompiled script has 1 element', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'SEND|0|X|1|addr', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled.length, 1)
    })

    it('rawData present: decompiled script has 2 elements', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'SEND|0|X|1|addr', 'extra-metadata', 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled.length, 2)
      assert.strictEqual(decompiled[1].toString('utf8'), 'extra-metadata')
    })

    it('small data + large rawData pushes combined size over OP_RETURN into P2SH', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      // data = 10 chars (10 bytes), rawData = 70 chars (70 bytes)
      // compiled([10-byte, 70-byte]) = 10+1 + 70+1 = 82 bytes → 82 + 4 magic = 86 > 80 → P2SH
      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'A'.repeat(10), 'B'.repeat(70), 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })

    it('small data + small rawData stays within OP_RETURN', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      // data = 30 chars, rawData = 30 chars
      // compiled([30-byte, 30-byte]) = 31 + 31 = 62 bytes → 62 + 4 = 66 ≤ 80 → OP_RETURN
      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'A'.repeat(30), 'B'.repeat(30), 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  // ── Null bytes in data ──────────────────────────────────────────

  describe('null bytes in data', () => {
    it('data with embedded null bytes survives round-trip intact', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      // Build a string with null bytes: "AB\x00CD\x00EF"
      const dataWithNulls = 'AB\x00CD\x00EF'
      assert.strictEqual(Buffer.byteLength(dataWithNulls, 'utf8'), 8)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        dataWithNulls, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)

      const decompiled = decompilePayload(payload.dataBuffer)
      const recovered = decompiled[0].toString('utf8')
      assert.strictEqual(recovered, dataWithNulls,
        'null bytes should survive encoding round-trip')
    })
  })

  // ── Very large payload requiring multiple chunks ────────────────

  describe('very large payload', () => {
    it('1000-byte data forced to OP_RETURN produces multiple outputs', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const bigData = 'X'.repeat(1000)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        bigData, null, 10000, false, 'OP_RETURN', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
      const opReturnOutputs = result.psbt.txOutputs.filter(o => o.value === 0)
      // 1000 bytes of data. compile([1000]) = 1003 (OP_PUSHDATA2 + 2-byte len + data).
      // prepareData chunks at 76 bytes each: ceil(1003 / 76) = 14 chunks
      assert.ok(opReturnOutputs.length >= 10,
        `expected many OP_RETURN outputs, got ${opReturnOutputs.length}`)
    })
  })
})
