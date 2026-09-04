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

// Fixes the fixtures on BTC. The forced-OP_RETURN over-capacity rejection itself
// is unconditional: singleOpReturnPolicy is declared but read nowhere (uuid:0ca8479c).
const NETWORK = 'bitcoin-regtest'

function standardUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

describe('Data/Payload Boundaries', () => {

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

  // An empty payload used to compile to an OP_0 push, take the 4-byte magic
  // word, and ship as a magic-word-only OP_RETURN carrying no action, so every
  // plain native-coin payment paid for a nulldata output and announced itself
  // as an XChain transaction. The emission loop now gets an empty chunk list
  // and writes nothing instead. These two cases assert the boundary in its
  // current position: nothing at data="", content one byte in.
  describe('empty data string', () => {
    it('data="" → no nulldata output at all (payment-only)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        '', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Still reported as OP_RETURN: every downstream single-transaction branch
      // keys off that value, and there is nothing to chunk either way.
      assert.strictEqual(result.encoding, 'OP_RETURN')
      const opReturnOutputs = result.psbt.txOutputs.filter(
        o => bitcoin.script.toASM(o.script).startsWith('OP_RETURN'))
      assert.strictEqual(opReturnOutputs.length, 0,
        'an empty payload must not buy a nulldata output')
      // The transaction is not empty, it is just a payment: change survives.
      assert.ok(result.psbt.txOutputs.some(o => Number(o.value) > 0),
        'change output is missing')
    })

    it('one-byte data is the smallest payload that still emits (MAGIC_WORD)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'X', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)
      assert.strictEqual(decompilePayload(payload.dataBuffer)[0].toString('utf8'), 'X')
    })
  })

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

  describe('very large payload', () => {
    it('1000-byte data forced to OP_RETURN is rejected (exceeds single output)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const bigData = 'X'.repeat(1000)

      // A transaction may carry at most one OP_RETURN output; Bitcoin Core
      // rejects multi-OP_RETURN transactions as non-standard at broadcast.
      // A 1000-byte payload (compiled 1003) cannot fit a single 76-byte chunk,
      // so it must be rejected at construction instead of producing a PSBT that
      // always fails to relay. Large payloads belong on the P2SH path.
      await assert.rejects(
        encoder.createTransaction(
          [standardUtxo()], address, null,
          bigData, null, 10000, false, 'OP_RETURN', address,
          null, null, null, true, 0.00001
        ),
        RangeError
      )
    })
  })
})
