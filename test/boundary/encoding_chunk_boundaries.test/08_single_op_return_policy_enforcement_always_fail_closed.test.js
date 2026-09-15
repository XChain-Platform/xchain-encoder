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
  describe('singleOpReturnPolicy enforcement (always fail-closed)', () => {
    it('throws RangeError for an oversized OP_RETURN when the flag is absent', () => {
      // A network config that omits singleOpReturnPolicy must STILL enforce the
      // single-output ceiling.
      const encoder = makeEncoder(NETWORK)
      delete encoder.network.singleOpReturnPolicy
      const oversized = Buffer.alloc(100) // > the 76-byte OP_RETURN payload ceiling
      assert.throws(() => encoder.prepareData(oversized, 'OP_RETURN'), RangeError)
    })

    it('throws RangeError for an oversized OP_RETURN even when singleOpReturnPolicy is explicitly false', () => {
      // The multi-chunk split path selected by this flag is unreassemblable (no
      // shipped decoder reads more than one OP_RETURN push) and unrelayable (Core's
      // IsStandardTx rejects multi-OP_RETURN as non-standard). The flag cannot
      // disarm the ceiling; an oversized OP_RETURN payload always throws.
      const encoder = makeEncoder(NETWORK)
      encoder.network.singleOpReturnPolicy = false
      const oversized = Buffer.alloc(100)
      assert.throws(() => encoder.prepareData(oversized, 'OP_RETURN'), RangeError)
    })

    it('a max-size single-chunk payload still encodes as exactly one OP_RETURN output regardless of the flag', () => {
      const encoder = makeEncoder(NETWORK)
      encoder.network.singleOpReturnPolicy = false
      const atCeiling = Buffer.alloc(76) // exactly the 76-byte OP_RETURN payload ceiling
      const prepared = encoder.prepareData(atCeiling, 'OP_RETURN')
      assert.strictEqual(prepared.dataBufferArray.length, 1)
      assert.strictEqual(prepared.dataBufferArray[0].length, 76 + 4) // + 4-byte magic word
    })
  })
})
