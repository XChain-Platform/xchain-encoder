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
 * Category C: Obfuscation Round-Trip
 *
 * Verifies the AES-128-CTR obfuscation/deobfuscation cycle with TXID-derived
 * keys across all encoding types.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  deobfuscate,
  extractOpReturnPayload,
  extractMultisignPayload,
  decompilePayload,
  MAGIC_WORD
} = require('./helpers/deobfuscate')
const {
  TXID_A,
  TXID_B,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('./helpers/utxoFactory')
const actions = require('./helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

describe('Category C: Obfuscation Round-Trip', () => {

  describe('C-1: OP_RETURN obfuscation round-trip', () => {
    it('deobfuscated OP_RETURN data has XCHN prefix and original ACTION', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)

      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled[0].toString('utf8'), action.data)
    })

    it('raw obfuscated bytes differ from plaintext', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      const decompiled = bitcoin.script.decompile(opReturnOutput.script)
      const obfuscatedData = decompiled[1]

      assert.notStrictEqual(
        obfuscatedData.subarray(0, 4).toString('utf8'),
        MAGIC_WORD,
        'obfuscated data should not contain plaintext magic word'
      )
    })
  })

  describe('C-2: MULTISIGN obfuscation round-trip', () => {
    const MS_DATA = 'A'.repeat(59)

    it('deobfuscated multisig data has XCHN prefix and original data', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const compressedPubKey = PUBKEY_BUF.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', address,
        null, null, compressedPubKey, true, 0.00001
      )

      const payload = extractMultisignPayload(result, TXID_MULTISIGN, encoder.dustAmount)
      assert.strictEqual(payload.magic, MAGIC_WORD)

      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled[0].toString('utf8'), MS_DATA)
    })
  })

  describe('C-3: P2SH marker obfuscation', () => {
    it('tx2 OP_RETURN marker deobfuscates to XCHNp2sh', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      const tx1Result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const tx1Hex = tx1Result.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1Result.psbt.__CACHE.__TX.getId()

      const tx2Result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      const markerOutput = tx2Result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(markerOutput, 'tx2 should have OP_RETURN marker')

      const decompiled = bitcoin.script.decompile(markerOutput.script)
      const obfuscatedMarker = decompiled[1]

      // The obfuscation key for tx2 is tx1Id (the first input txid of tx2)
      const decrypted = deobfuscate(obfuscatedMarker, tx1Id)
      const markerStr = decrypted.toString('utf8')

      assert.strictEqual(markerStr, 'XCHNp2sh')
    })
  })

  describe('C-4: TXID sensitivity', () => {
    it('same ACTION with different TXIDs produces different obfuscated output', async () => {
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const encoderA = makeEncoder(NETWORK)
      const utxoA = makeSegwitUtxo(TXID_A, 0, 100000000)
      const resultA = await encoderA.createTransaction(
        [utxoA], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const encoderB = makeEncoder(NETWORK)
      const utxoB = makeSegwitUtxo(TXID_B, 0, 100000000)
      const resultB = await encoderB.createTransaction(
        [utxoB], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const outputA = resultA.psbt.txOutputs.find(o => o.value === 0)
      const dataA = bitcoin.script.decompile(outputA.script)[1]

      const outputB = resultB.psbt.txOutputs.find(o => o.value === 0)
      const dataB = bitcoin.script.decompile(outputB.script)[1]

      assert.ok(!dataA.equals(dataB),
        'same data obfuscated with different TXIDs should produce different output')

      const payloadA = extractOpReturnPayload(resultA, TXID_A)
      const payloadB = extractOpReturnPayload(resultB, TXID_B)
      assert.strictEqual(payloadA.magic, MAGIC_WORD)
      assert.strictEqual(payloadB.magic, MAGIC_WORD)

      const decompA = decompilePayload(payloadA.dataBuffer)
      const decompB = decompilePayload(payloadB.dataBuffer)
      assert.strictEqual(decompA[0].toString('utf8'), decompB[0].toString('utf8'))
    })
  })

  describe('C-5: UTXO sorting preserves obfuscation key derivation', () => {
    it('obfuscation uses largest UTXO txid regardless of input order', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      // Provide UTXOs in smallest-first order
      const smallUtxo = makeSegwitUtxo(TXID_B, 0, 10000000)  // 0.1 BTC
      const largeUtxo = makeSegwitUtxo(TXID_A, 0, 100000000) // 1 BTC

      const result = await encoder.createTransaction(
        [smallUtxo, largeUtxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD,
        'obfuscation key should derive from largest UTXO txid (TXID_A)')

      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled[0].toString('utf8'), action.data)
    })

    it('deobfuscation with wrong TXID produces garbage', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_B)
      assert.notStrictEqual(payload.magic, MAGIC_WORD,
        'wrong TXID should not produce valid magic word')
    })
  })
})
