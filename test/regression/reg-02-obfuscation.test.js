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
 * REG-02: Obfuscation Round-Trip
 *
 * Regression sentinel for the AES-128-CTR obfuscation layer. Verifies key
 * derivation from TXID, cipher symmetry, determinism, and the dependency
 * between UTXO sort order and obfuscation key selection.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  deobfuscate,
  extractOpReturnPayload,
  decompilePayload,
  MAGIC_WORD
} = require('../integration/helpers/deobfuscate')
const {
  TXID_A,
  TXID_B,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

describe('REG-02: Obfuscation Round-Trip', function () {

  describe('REG-02.1: Basic obfuscate() method', function () {
    it('output length equals input length (CTR mode is length-preserving)', async function () {
      const encoder = makeEncoder(NETWORK)
      const plaintext = Buffer.from('XCHNTEST|0|JDOG|100', 'utf8')
      const encrypted = await encoder.obfuscate(plaintext, TXID_A)
      assert.strictEqual(encrypted.length, plaintext.length)
    })

    it('output differs from plaintext', async function () {
      const encoder = makeEncoder(NETWORK)
      const plaintext = Buffer.from('XCHNTEST|0|JDOG|100', 'utf8')
      const encrypted = await encoder.obfuscate(plaintext, TXID_A)
      assert.ok(!plaintext.equals(encrypted), 'encrypted should differ from plaintext')
    })

    it('round-trips: obfuscate then deobfuscate recovers original', async function () {
      const encoder = makeEncoder(NETWORK)
      const plaintext = Buffer.from('XCHNSEND|0|JDOG|1|addr', 'utf8')
      const encrypted = await encoder.obfuscate(plaintext, TXID_A)
      const decrypted = deobfuscate(encrypted, TXID_A)
      assert.ok(plaintext.equals(decrypted), 'decrypted should match original')
    })

    it('deterministic: same data+key always produces same output', async function () {
      const encoder = makeEncoder(NETWORK)
      const plaintext = Buffer.from('XCHNSEND|0|JDOG|1|addr', 'utf8')
      const enc1 = await encoder.obfuscate(plaintext, TXID_A)
      const enc2 = await encoder.obfuscate(plaintext, TXID_A)
      assert.ok(enc1.equals(enc2), 'two encryptions with same key should match')
    })

    it('key derivation uses first 16 chars as key, next 16 as IV', async function () {
      const encoder = makeEncoder(NETWORK)
      const plaintext = Buffer.from('XCHNTEST', 'utf8')

      // TXID_A = 'a'.repeat(64), so key='aaaaaaaaaaaaaaaa', iv='aaaaaaaaaaaaaaaa'
      const encrypted = await encoder.obfuscate(plaintext, TXID_A)

      // Manually verify using deobfuscate with the same TXID
      const decrypted = deobfuscate(encrypted, TXID_A)
      assert.strictEqual(decrypted.toString('utf8'), 'XCHNTEST')
    })
  })

  describe('REG-02.2: TXID sensitivity', function () {
    it('same ACTION with different TXIDs produces different ciphertext', async function () {
      const encoder = makeEncoder(NETWORK)
      const plaintext = Buffer.from('XCHNSEND|0|JDOG|1|addr', 'utf8')
      const encA = await encoder.obfuscate(plaintext, TXID_A)
      const encB = await encoder.obfuscate(plaintext, TXID_B)
      assert.ok(!encA.equals(encB), 'different TXIDs should produce different ciphertext')
    })

    it('wrong TXID for deobfuscation produces non-XCHN prefix', async function () {
      const encoder = makeEncoder(NETWORK)
      const plaintext = Buffer.from('XCHNSEND|0|JDOG|1|addr', 'utf8')
      const encrypted = await encoder.obfuscate(plaintext, TXID_A)
      const wrongDecrypt = deobfuscate(encrypted, TXID_B)
      const prefix = wrongDecrypt.subarray(0, 4).toString('utf8')
      assert.notStrictEqual(prefix, MAGIC_WORD, 'wrong key should not produce XCHN prefix')
    })
  })

  describe('REG-02.3: UTXO sort determines obfuscation key', function () {
    it('largest UTXO TXID is always the obfuscation key', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      // Provide two UTXOs: TXID_B is larger → should be sorted first → used as key
      const utxoSmall = makeSegwitUtxo(TXID_A, 0, 10000)
      const utxoLarge = makeSegwitUtxo(TXID_B, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxoSmall, utxoLarge], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Deobfuscate with TXID_B (the larger UTXO) should yield XCHN
      const payload = extractOpReturnPayload(result, TXID_B)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })

    it('input order does not change key derivation', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const utxoSmall = makeSegwitUtxo(TXID_A, 0, 10000)
      const utxoLarge = makeSegwitUtxo(TXID_B, 0, 100000000)

      // Reverse input order
      const result = await encoder.createTransaction(
        [utxoLarge, utxoSmall], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Still TXID_B (largest value) regardless of input array order
      const payload = extractOpReturnPayload(result, TXID_B)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })
  })

  describe('REG-02.4: P2SH/P2WSH marker strings', function () {
    it('P2SH tx2 OP_RETURN marker deobfuscates to XCHNp2sh', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('MARKER')

      // tx1
      const tx1 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // NOTE: __CACHE.__TX is a bitcoinjs-lib internal (matches existing test pattern)
      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      // tx2
      const tx2 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      const markerOutput = tx2.psbt.txOutputs.find(o => o.value === 0)
      const decompiled = bitcoin.script.decompile(markerOutput.script)
      const decrypted = deobfuscate(decompiled[1], tx1Id)
      assert.strictEqual(decrypted.toString('utf8'), 'XCHNp2sh')
    })

    it('P2WSH tx2 OP_RETURN marker deobfuscates to XCHNp2wsh', async function () {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeFileLarge()

      const tx1 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      const tx2 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      const markerOutput = tx2.psbt.txOutputs.find(o => o.value === 0)
      const decompiled = bitcoin.script.decompile(markerOutput.script)
      const decrypted = deobfuscate(decompiled[1], tx1Id)
      assert.strictEqual(decrypted.toString('utf8'), 'XCHNp2wsh')
    })
  })
})
