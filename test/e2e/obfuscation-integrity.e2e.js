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
 * E2E-4: Obfuscation Integrity
 *
 * Verifies AES-128-CTR obfuscation with TXID-derived keys is reversible,
 * non-trivial, and consistent across encoding types.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  deobfuscate,
  extractOpReturnPayload,
  extractMultisignPayload,
  decompilePayload,
  MAGIC_WORD
} = require('../integration/helpers/deobfuscate')
const {
  TXID_A,
  TXID_B,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

function stdUtxo (txid) {
  return makeSegwitUtxo(txid || TXID_A, 0, 100000000)
}

describe('E2E-4: Obfuscation Integrity', () => {

  describe('E2E-4.1: OP_RETURN obfuscation round-trip', () => {
    it('deobfuscated OP_RETURN data has XCHN prefix and original ACTION', async () => {
      const action = actions.makeSend('JDOG', '100', actions.ADDR_BTC)
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)

      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled[0].toString('utf8'), action.data)

      // Also verify raw obfuscated bytes differ from plaintext
      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      const scriptDecompiled = bitcoin.script.decompile(opReturnOutput.script)
      const rawObfuscated = scriptDecompiled[1]
      assert.notStrictEqual(
        rawObfuscated.subarray(0, 4).toString('utf8'),
        MAGIC_WORD,
        'raw output should be obfuscated, not plaintext'
      )
    })
  })

  describe('E2E-4.2: MULTISIGN obfuscation round-trip', () => {
    it('fake pubkey data deobfuscates to original payload', async () => {
      const MS_DATA = 'A'.repeat(59)
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', address,
        null, null, PUBKEY_BUF.toString('hex'), true, 0.00001
      )

      const payload = extractMultisignPayload(result, TXID_MULTISIGN, encoder.dustAmount)
      assert.strictEqual(payload.magic, MAGIC_WORD)

      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled[0].toString('utf8'), MS_DATA)
    })
  })

  describe('E2E-4.3: P2SH tx2 marker obfuscation round-trip', () => {
    it('tx2 OP_RETURN marker deobfuscates with tx1 ID to XCHNp2sh', async () => {
      const action = actions.makeIssueFull('OBFTEST')
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()

      // tx1
      const tx1 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      // tx2
      const tx2 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      // The OP_RETURN marker in tx2 IS obfuscated (unlike redeemScript data)
      const markerOutput = tx2.psbt.txOutputs.find(o => o.value === 0)
      const decompiled = bitcoin.script.decompile(markerOutput.script)
      const decrypted = deobfuscate(decompiled[1], tx1Id)

      assert.strictEqual(decrypted.toString('utf8'), 'XCHNp2sh')

      // But the redeemScript data itself is NOT obfuscated
      const input = tx2.psbt.data.inputs[0]
      const rsDecompiled = bitcoin.script.decompile(input.redeemScript)
      const dataChunk = rsDecompiled[0]
      const innerDecompiled = decompilePayload(dataChunk)
      assert.strictEqual(innerDecompiled[0].toString('utf8'), action.data)
    })
  })

  describe('E2E-4.4: TXID sensitivity', () => {
    it('same ACTION with different TXIDs produces different ciphertext', async () => {
      const action = actions.makeSend()
      const address = getTestAddress(NETWORK)

      const encoderA = makeEncoder(NETWORK)
      const resultA = await encoderA.createTransaction(
        [stdUtxo(TXID_A)], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const encoderB = makeEncoder(NETWORK)
      const resultB = await encoderB.createTransaction(
        [stdUtxo(TXID_B)], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const outputA = resultA.psbt.txOutputs.find(o => o.value === 0)
      const dataA = bitcoin.script.decompile(outputA.script)[1]

      const outputB = resultB.psbt.txOutputs.find(o => o.value === 0)
      const dataB = bitcoin.script.decompile(outputB.script)[1]

      assert.ok(!dataA.equals(dataB), 'different TXIDs should produce different ciphertext')

      // But both decode to same plaintext
      const payloadA = extractOpReturnPayload(resultA, TXID_A)
      const payloadB = extractOpReturnPayload(resultB, TXID_B)
      const decA = decompilePayload(payloadA.dataBuffer)[0].toString('utf8')
      const decB = decompilePayload(payloadB.dataBuffer)[0].toString('utf8')
      assert.strictEqual(decA, decB)
    })
  })

  describe('E2E-4.5: UTXO sorting preserves obfuscation key', () => {
    it('key derives from largest-value UTXO regardless of input order', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      // Provide UTXOs smallest-first; TXID_A is the largest
      const small = makeSegwitUtxo(TXID_B, 0, 10000000)
      const large = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [small, large], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // TXID_A should be the obfuscation key (largest value, sorted first)
      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })
  })

  describe('E2E-4.6: Wrong TXID detection (negative test)', () => {
    it('deobfuscation with wrong TXID does not produce XCHN magic', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_B) // wrong TXID
      assert.notStrictEqual(payload.magic, MAGIC_WORD, 'wrong TXID should not yield valid magic')
    })
  })

  describe('E2E-4.7: Oversized OP_RETURN rejected', () => {
    it('forced OP_RETURN beyond a single output is rejected', async () => {
      // Bitcoin permits only one OP_RETURN per transaction, so an oversized
      // payload must reject here rather than split into independently
      // obfuscated outputs; force the bitcoin network since dogecoin/litecoin
      // allow multiple OP_RETURNs.
      const bigData = 'Y'.repeat(200)
      const orNet = 'bitcoin-regtest'
      const encoder = makeEncoder(orNet)
      const address = getTestAddress(orNet)
      const utxo = stdUtxo()

      await assert.rejects(
        encoder.createTransaction(
          [utxo], address, null,
          bigData, null, 10000, false, 'OP_RETURN', address,
          null, null, null, true, 0.00001
        ),
        RangeError
      )
    })
  })
})
