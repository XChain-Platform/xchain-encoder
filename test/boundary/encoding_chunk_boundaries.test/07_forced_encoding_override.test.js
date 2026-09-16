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
  describe('forced encoding override', () => {
    it('small data forced to P2SH produces P2SH output', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const result = await encoder.createTransaction(
        [standardUtxo()], address, null,
        'SEND|0|X|1|a', null, 10000, false, 'P2SH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })

    it('invalid encoding string throws TypeError from prepareData', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      // prepareData throws TypeError for unknown encoding
      await assert.rejects(
        () => encoder.createTransaction(
          [standardUtxo()], address, null,
          'test', null, 10000, false, 'INVALID_TYPE', address,
          null, null, null, true, 0.00001
        ),
        { name: 'TypeError' }
      )
    })
  })
})
