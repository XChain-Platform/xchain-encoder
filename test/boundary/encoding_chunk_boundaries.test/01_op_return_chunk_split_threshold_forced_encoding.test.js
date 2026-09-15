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
  describe('OP_RETURN chunk-split threshold (forced encoding)', () => {
    it('75-char data → 1 OP_RETURN output', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'A'.repeat(75), null, 10000, false, 'OP_RETURN', address,
        null, null, null, true, 0.00001
      )

      const opReturnOutputs = result.psbt.txOutputs.filter(o => o.value === 0)
      assert.strictEqual(opReturnOutputs.length, 1,
        '75-char data (compiled=76) fits in one 76-byte chunk + 4 magic = 80')
    })

    // A transaction may carry at most one OP_RETURN output; Bitcoin Core
    // rejects multi-OP_RETURN transactions as non-standard at broadcast.
    // Forcing OP_RETURN with a payload that would not fit a single 76-byte
    // chunk must therefore be rejected at construction, not split into outputs
    // that always fail to relay.
    it('76-char data (compiled=78) → rejected (would exceed single output)', async () => {
      // Rejects an oversized forced OP_RETURN on every coin: prepareData enforces the
      // ceiling unconditionally, so bitcoin-regtest here is a fixture, not a condition.
      const orNet = 'bitcoin-regtest'
      const encoder = makeEncoder(orNet)
      const address = getTestAddress(orNet)

      await assert.rejects(
        encoder.createTransaction(
          [standardUtxo()], address, null,
          'A'.repeat(76), null, 10000, false, 'OP_RETURN', address,
          null, null, null, true, 0.00001
        ),
        RangeError
      )
    })
  })
})

describe('Encoding Chunk Boundaries: Full Pipeline', () => {
  describe('OP_RETURN chunk-split threshold (forced encoding)', () => {
    it('150-char data (compiled=152) → rejected', async () => {
      // Rejects on every shipped coin; bitcoin-regtest here is a fixture, not a condition
      const orNet = 'bitcoin-regtest'
      const encoder = makeEncoder(orNet)
      const address = getTestAddress(orNet)

      await assert.rejects(
        encoder.createTransaction(
          [standardUtxo()], address, null,
          'A'.repeat(150), null, 10000, false, 'OP_RETURN', address,
          null, null, null, true, 0.00001
        ),
        RangeError
      )
    })

    it('151-char data (compiled=153) → rejected', async () => {
      // Rejects on every shipped coin; bitcoin-regtest here is a fixture, not a condition
      const orNet = 'bitcoin-regtest'
      const encoder = makeEncoder(orNet)
      const address = getTestAddress(orNet)

      await assert.rejects(
        encoder.createTransaction(
          [standardUtxo()], address, null,
          'A'.repeat(151), null, 10000, false, 'OP_RETURN', address,
          null, null, null, true, 0.00001
        ),
        RangeError
      )
    })
  })
})
