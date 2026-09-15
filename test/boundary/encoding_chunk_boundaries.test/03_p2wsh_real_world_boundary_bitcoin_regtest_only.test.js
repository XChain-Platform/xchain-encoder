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
  describe('P2WSH real-world boundary (bitcoin-regtest only)', () => {
    // PW2SH_SIZE = 520, giving a chunk capacity of 476 bytes, the same as
    // P2SH. Each data chunk is pushed as a single script element inside the
    // witness script, so it is bound by consensus MAX_SCRIPT_ELEMENT_SIZE
    // (520), NOT by the larger total witness-script policy limit. (A bigger
    // chunk builds a witness script the node rejects at spend time with
    // "Push value size limit exceeded".) Through the full pipeline a 473-char
    // string (compiled to 476 bytes with a 3-byte OP_PUSHDATA2 prefix) is the
    // last to fit in one chunk; 474 chars (compiled 477) splits to 2.

    it('473-char data → 1 P2WSH output (last single-chunk size)', async () => {
      const p2wshNet = 'bitcoin-regtest'
      const encoder = makeEncoder(p2wshNet)
      const address = getTestAddress(p2wshNet)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'A'.repeat(473), null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2WSH')
      const nonZeroOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(nonZeroOutputs.length, 2)
    })

    it('474-char data (compiled=477) → 2 P2WSH outputs (crosses chunk boundary)', async () => {
      // chunksSize = PW2SH_SIZE(520) - 44 = 476. Compiled 477 > 476 → 2 chunks.
      const p2wshNet = 'bitcoin-regtest'
      const encoder = makeEncoder(p2wshNet)
      const address = getTestAddress(p2wshNet)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'A'.repeat(474), null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2WSH')
      // 2 P2WSH outputs + change
      const nonZeroOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(nonZeroOutputs.length, 3)
    })

    it('small P2WSH data (500 chars) works correctly', async () => {
      const p2wshNet = 'bitcoin-regtest'
      const encoder = makeEncoder(p2wshNet)
      const address = getTestAddress(p2wshNet)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'A'.repeat(500), null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2WSH')
    })
  })
})
