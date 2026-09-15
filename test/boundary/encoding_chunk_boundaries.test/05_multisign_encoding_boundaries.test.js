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
  describe('MULTISIGN encoding boundaries', () => {
    // MULTISIGN chunk capacity = MULTISIGN_SIZE(69) - 4(magic) - 5(overhead) = 60
    // bytes of raw data (src/XChainEncoder.js: MULTISIGN_SIZE = 69).
    // Each obfuscated chunk is split across two fake pubkeys: pk1 = [0:32], pk2 = [32:end].
    // A full chunk is magic(4) + 60 = 64 obfuscated bytes, so pk2 = [32:64] is exactly
    // 32 bytes - the largest dataToPubkey() slice that stays a valid 33-byte
    // compressed key. prepareData() zero-pads every chunk up to the 64-byte slot so
    // both pubkey halves are always complete 32-byte values.
    //
    // The bug is CLOSED: the former MULTISIGN_SIZE = 71 gave a 62-byte chunk whose
    // pk2 could reach 33 bytes (an invalid EC point). With MULTISIGN_SIZE = 69 the
    // chunk is capped at 60 and pk2 never exceeds 32 bytes, so a payload that would
    // payload that overflows one chunk splits cleanly into two valid MULTISIGN outputs.

    it('59-char data (compiled=60): valid 1-MULTISIGN output', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = standardUtxo(TXID_MULTISIGN)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'A'.repeat(59), null, 10000, false, 'MULTISIGN', address,
        null, null, PUBKEY_BUF.toString('hex'), true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')
      const msOutputs = result.psbt.txOutputs.filter(o =>
        o.value === encoder.dustAmount)
      assert.strictEqual(msOutputs.length, 1, 'should have 1 multisig output')
    })
  })
})

describe('Encoding Chunk Boundaries: Full Pipeline', () => {
  describe('MULTISIGN encoding boundaries', () => {
    it('60-char data (compiled=61): produces exactly 2 MULTISIGN outputs', async () => {
      // With MULTISIGN_SIZE=69 the chunk capacity is 60, so compiled data of 61
      // bytes splits into exactly 2 chunks. prepareData zero-pads each chunk to the
      // full 64-byte slot, so both data pubkey halves (pk1=[0:32], pk2=[32:64]) are
      // complete 33-byte compressed keys. The zero-pad fix is what this guards: drop
      // it and the short final chunk would produce a malformed pk2 that typeforce
      // rejects ("Expected property pubkeys.1"). No try/catch: the build must
      // succeed unconditionally for this fixture.
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = standardUtxo(TXID_MULTISIGN)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'A'.repeat(60), null, 10000, false, 'MULTISIGN', address,
        null, null, PUBKEY_BUF.toString('hex'), true, 0.00001
      )

      const msOutputs = result.psbt.txOutputs.filter(o =>
        o.value === encoder.dustAmount)
      assert.strictEqual(msOutputs.length, 2, 'should have exactly 2 multisig outputs')

      // Each emitted MULTISIGN output's script must decompile to full 33-byte
      // pubkey pushes for both data halves (the point of the zero-pad fix).
      for (const out of msOutputs) {
        const parts = bitcoin.script.decompile(out.script)
        const pubkeyPushes = parts.filter(p => Buffer.isBuffer(p) && p.length === 33)
        assert.ok(pubkeyPushes.length >= 2,
          'each MULTISIGN output should decompile to two 33-byte pubkey pushes (the data halves)')
      }
    })

    it('MULTISIGN without compressedPubKey throws', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = standardUtxo(TXID_MULTISIGN)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'A'.repeat(59), null, 10000, false, 'MULTISIGN', address,
          null, null, null, true, 0.00001
        )
      )
    })
  })
})
