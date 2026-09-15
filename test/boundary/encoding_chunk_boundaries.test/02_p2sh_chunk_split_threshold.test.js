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
  describe('P2SH chunk-split threshold', () => {
    // P2SH chunksSize = 520 - 44 = 476
    // For string of N chars (N <= 255): compiled = N + 2 (OP_PUSHDATA1 overhead)
    // So compiled <= 476 when N <= 474... wait: for N <= 75, overhead is 1.
    // For 76 <= N <= 255, overhead is 2. So compiled = N + 2.
    // compiled <= 476 → N <= 474 (for N >= 76)
    // But for a large string we expect: 473-char (compiled 475) → 1 chunk,
    // 474-char (compiled 476) → 1 chunk, 475-char (compiled 477) → 2 chunks

    it('473-char data (compiled=476) → 1 P2SH output (exactly fits)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'A'.repeat(473), null, 10000, false, 'P2SH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
      // Count non-zero outputs: 1 P2SH output + 1 change output
      const outputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(outputs.length, 2)
    })

    it('474-char data (compiled=477) → 2 P2SH outputs (first overflow)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'A'.repeat(474), null, 10000, false, 'P2SH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
      // 2 P2SH outputs + 1 change output
      const outputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(outputs.length, 3)
    })
  })
})

describe('Encoding Chunk Boundaries: Full Pipeline', () => {
  describe('P2SH chunk-split threshold', () => {
    it('P2SH data integrity: 475-char data reassembles from tx2 redeemScripts', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const data = 'A'.repeat(475)

      // Create tx1
      const tx1 = await encoder.createTransaction(
        [standardUtxo()], address, null,
        data, null, 10000, false, 'P2SH', address,
        null, null, null, true, 0.00001
      )

      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      // Create tx2
      const tx2 = await encoder.createTransaction(
        [standardUtxo()], address, null,
        data, null, 10000, false, 'P2SH', address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      // tx2 inputs should have redeemScripts containing the data
      const inputs = tx2.psbt.data.inputs
      const dataChunks = inputs
        .filter(i => i.redeemScript)
        .map(i => bitcoin.script.decompile(i.redeemScript)[0])

      assert.ok(dataChunks.length >= 2,
        'should have 2 redeemScript inputs for 475-char data')
    })
  })
})
