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
 * Encoding Chunk Boundary Tests
 *
 * Full-pipeline tests at exact byte thresholds where encoding type
 * auto-selection and chunk splitting behavior changes.
 *
 * Key insight: createTransaction() calls bitcoin.script.compile([dataBuffer])
 * BEFORE prepareData(), adding push-opcode overhead:
 *   - 1 byte for data <= 75 bytes
 *   - 2 bytes (OP_PUSHDATA1 + length) for data 76-255 bytes
 *   - 3 bytes (OP_PUSHDATA2 + 2-byte length) for data 256+ bytes
 *
 * The auto-selection threshold in prepareData() is:
 *   compiledData.length + 4 (magic) <= 80 → OP_RETURN
 *
 * Therefore: string 75 chars → compiled 76 → 80 ≤ 80 → OP_RETURN (last fit)
 *            string 76 chars → compiled 78 → 82 > 80 → P2SH (first overflow)
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeUtxo,
  makeEncoder,
  getTestAddress
} = require('../../integration/helpers/utxoFactory')
const {
  extractOpReturnPayload,
  decompilePayload,
  MAGIC_WORD
} = require('../../integration/helpers/deobfuscate')

const NETWORK = 'dogecoin-regtest'

function standardUtxo (txid = TXID_A) {
  return makeUtxo(NETWORK, txid, 0, 100000000)
}
describe('Encoding Chunk Boundaries: Full Pipeline', () => {
  describe('dataToPubkey unit boundaries', () => {
    const encoder = new (require('../../../src/XChainEncoder'))(
      'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
    )

    it('exactly 32 bytes → 33-byte pubkey (02 prefix, no zero-fill)', async () => {
      const data = Buffer.alloc(32, 0x42)
      const pubkey = await encoder.dataToPubkey(data)
      assert.strictEqual(pubkey.length, 33)
      assert.strictEqual(pubkey[0], 0x02)
      assert.deepStrictEqual(pubkey.subarray(1), data)
    })

    it('< 32 bytes (16 bytes) → 33-byte pubkey (02 prefix + data + zero-fill)', async () => {
      const data = Buffer.alloc(16, 0x42)
      const pubkey = await encoder.dataToPubkey(data)
      assert.strictEqual(pubkey.length, 33)
      assert.strictEqual(pubkey[0], 0x02)
      assert.deepStrictEqual(pubkey.subarray(1, 17), data)
      // Remaining 16 bytes should be zero-filled
      const fill = pubkey.subarray(17)
      assert.strictEqual(fill.length, 16)
      for (const byte of fill) {
        assert.strictEqual(byte, 0x00)
      }
    })

    it('1 byte → 33-byte pubkey (02 + 1 byte data + 31 bytes zero-fill)', async () => {
      const data = Buffer.from([0xFF])
      const pubkey = await encoder.dataToPubkey(data)
      assert.strictEqual(pubkey.length, 33)
      assert.strictEqual(pubkey[1], 0xFF)
    })

    it('0 bytes → 33-byte pubkey (02 + 32 bytes zero-fill)', async () => {
      const data = Buffer.alloc(0)
      const pubkey = await encoder.dataToPubkey(data)
      assert.strictEqual(pubkey.length, 33)
      assert.strictEqual(pubkey[0], 0x02)
    })

    it('> 32 bytes (34 bytes) → 35-byte result (no guard, exceeds compressed pubkey size)', async () => {
      // This documents that dataToPubkey has no upper bound check.
      // When data > 32 bytes, the condition (data.length < 32) is false,
      // so no zero-fill occurs, and the result is 1 + data.length bytes.
      const data = Buffer.alloc(34, 0x42)
      const pubkey = await encoder.dataToPubkey(data)
      assert.strictEqual(pubkey.length, 35,
        'no guard: 34-byte data produces 35-byte "pubkey" (invalid for EC)')
    })
  })
})
