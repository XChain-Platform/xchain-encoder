/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Category B: Encoding Type Integration
 *
 * Verifies that each of the 4 encoding types (OP_RETURN, P2SH, P2WSH,
 * MULTISIGN) produces structurally valid PSBTs with correctly embedded data.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  extractOpReturnPayload,
  extractMultisignPayload,
  decompilePayload,
  MAGIC_WORD
} = require('./helpers/deobfuscate')
const {
  TXID_A,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('./helpers/utxoFactory')
const actions = require('./helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

describe('Category B: Encoding Type Integration', () => {

  // ── B-1: OP_RETURN script structure ─────────────────────────────

  describe('B-1: OP_RETURN script structure', () => {
    it('output has value=0 and script starts with OP_RETURN (0x6a)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')

      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(opReturnOutput, 'should have an OP_RETURN output')
      assert.strictEqual(opReturnOutput.script[0], bitcoin.opcodes.OP_RETURN)

      // Decompile and verify obfuscated data is present
      const decompiled = bitcoin.script.decompile(opReturnOutput.script)
      assert.ok(Buffer.isBuffer(decompiled[1]), 'data should be a buffer after OP_RETURN')
    })

    it('contains obfuscated XCHN-prefixed data', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })
  })

  // ── B-2: P2SH tx1 (funding output) ─────────────────────────────

  describe('B-2: P2SH tx1 — funding output', () => {
    it('creates P2SH output with value >= dustAmount', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')

      // Find P2SH outputs by script pattern: OP_HASH160 <20-byte-hash> OP_EQUAL
      const outputs = result.psbt.txOutputs
      const p2shOutputs = outputs.filter(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160 &&
               Buffer.isBuffer(d[1]) && d[1].length === 20 &&
               d[2] === bitcoin.opcodes.OP_EQUAL
      })
      assert.ok(p2shOutputs.length >= 1, 'should have at least one P2SH output')

      for (const output of p2shOutputs) {
        assert.ok(output.value >= encoder.dustAmount,
          `P2SH output value ${output.value} should be >= dust ${encoder.dustAmount}`)
      }
    })

    it('has a change output returning remaining funds', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const outputs = result.psbt.txOutputs
      const changeOutput = outputs.reduce((max, o) =>
        o.value > max.value ? o : max, { value: 0 })
      assert.ok(changeOutput.value > 0, 'should have a change output')
    })
  })

  // ── B-3: P2SH tx2 (spending input) ─────────────────────────────

  describe('B-3: P2SH tx2 — spending input with redeemScript', () => {
    it('creates tx2 with P2SH input and OP_RETURN marker', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      // Create tx1
      const tx1Result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const tx1Hex = tx1Result.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1Result.psbt.__CACHE.__TX.getId()

      // Create tx2
      const tx2Result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      assert.strictEqual(tx2Result.encoding, 'P2SH')

      // tx2 should have at least 1 input (the P2SH spend)
      assert.ok(tx2Result.psbt.data.inputs.length >= 1)

      // tx2 should have an OP_RETURN marker output with value 0
      const markerOutput = tx2Result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(markerOutput, 'tx2 should have OP_RETURN marker')
      assert.strictEqual(markerOutput.script[0], bitcoin.opcodes.OP_RETURN)
    })

    it('tx2 P2SH input has redeemScript containing ACTION data', async () => {
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

      // The first input should have a redeemScript
      const input = tx2Result.psbt.data.inputs[0]
      assert.ok(input.redeemScript, 'P2SH input should have redeemScript')

      // Decompile the redeemScript to verify it contains data
      const decompiled = bitcoin.script.decompile(input.redeemScript)
      assert.ok(Buffer.isBuffer(decompiled[0]), 'first element should be data')
      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)
      assert.strictEqual(decompiled[2], bitcoin.opcodes.OP_DUP)
      assert.strictEqual(decompiled[3], bitcoin.opcodes.OP_HASH160)
    })
  })

  // ── B-4: P2WSH tx1 (funding output) ────────────────────────────

  describe('B-4: P2WSH tx1 — funding output', () => {
    it('creates P2WSH output when explicitly requested', async () => {
      // P2WSH requires bech32 network config — use bitcoin-regtest (Dogecoin lacks bech32)
      const p2wshNetwork = 'bitcoin-regtest'
      const encoder = makeEncoder(p2wshNetwork)
      const address = getTestAddress(p2wshNetwork)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      // Use large data that benefits from P2WSH
      const action = actions.makeFileLarge()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2WSH')

      // P2WSH output script: OP_0 <32-byte-hash>
      const outputs = result.psbt.txOutputs
      const p2wshOutputs = outputs.filter(o => {
        if (o.value <= 0) return false
        const decompiled = bitcoin.script.decompile(o.script)
        return decompiled && decompiled[0] === bitcoin.opcodes.OP_0 &&
               Buffer.isBuffer(decompiled[1]) && decompiled[1].length === 32
      })
      assert.ok(p2wshOutputs.length >= 1, 'should have at least one P2WSH output')
    })
  })

  // ── B-5: P2WSH tx2 (spending input) ────────────────────────────

  describe('B-5: P2WSH tx2 — witness input', () => {
    it('creates tx2 with witnessScript containing ACTION data', async () => {
      // P2WSH requires bech32 — use bitcoin-regtest
      const p2wshNetwork = 'bitcoin-regtest'
      const encoder = makeEncoder(p2wshNetwork)
      const address = getTestAddress(p2wshNetwork)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeFileLarge()

      // Create tx1
      const tx1Result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      const tx1Hex = tx1Result.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1Result.psbt.__CACHE.__TX.getId()

      // Create tx2
      const tx2Result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      assert.strictEqual(tx2Result.encoding, 'P2WSH')

      // tx2 first input should have a witnessScript
      const input = tx2Result.psbt.data.inputs[0]
      assert.ok(input.witnessScript, 'P2WSH input should have witnessScript')

      // Decompile the witnessScript
      const decompiled = bitcoin.script.decompile(input.witnessScript)
      assert.ok(Buffer.isBuffer(decompiled[0]), 'first element should be data')
      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)

      // tx2 should have OP_RETURN marker
      const markerOutput = tx2Result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(markerOutput, 'tx2 should have OP_RETURN marker')
    })
  })

  // ── B-6: MULTISIGN output structure ─────────────────────────────

  describe('B-6: MULTISIGN output structure', () => {
    // MULTISIGN requires data that produces valid EC points after obfuscation.
    // Use TXID_MULTISIGN (brute-forced) with carefully sized data.
    const MS_DATA = 'A'.repeat(59) // compiles to ~60 bytes → 64-byte chunk after XCHN

    it('creates 1-of-3 multisig output with correct structure', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const compressedPubKey = PUBKEY_BUF.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', address,
        null, null, compressedPubKey, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')

      // Find the multisig output (value = dustAmount)
      const msOutput = result.psbt.txOutputs.find(o =>
        o.value === encoder.dustAmount
      )
      assert.ok(msOutput, 'should have a multisig output at dust value')

      // Decompile: OP_1 <pk1> <pk2> <pk3> OP_3 OP_CHECKMULTISIG
      const decompiled = bitcoin.script.decompile(msOutput.script)
      assert.strictEqual(decompiled[0], bitcoin.opcodes.OP_1) // m = 1
      assert.ok(Buffer.isBuffer(decompiled[1])) // pubkey1 (fake)
      assert.strictEqual(decompiled[1].length, 33)
      assert.ok(Buffer.isBuffer(decompiled[2])) // pubkey2 (fake)
      assert.strictEqual(decompiled[2].length, 33)
      assert.ok(Buffer.isBuffer(decompiled[3])) // pubkey3 (real)
      assert.strictEqual(decompiled[3].length, 33)
      assert.strictEqual(decompiled[4], bitcoin.opcodes.OP_3) // n = 3
      assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_CHECKMULTISIG)
    })

    it('third pubkey is the real compressed public key', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const compressedPubKey = PUBKEY_BUF.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', address,
        null, null, compressedPubKey, true, 0.00001
      )

      const msOutput = result.psbt.txOutputs.find(o =>
        o.value === encoder.dustAmount
      )
      const decompiled = bitcoin.script.decompile(msOutput.script)
      assert.deepStrictEqual(decompiled[3], PUBKEY_BUF)
    })
  })

  // ── B-7: Forced encoding override ──────────────────────────────

  describe('B-7: Forced encoding override', () => {
    it('uses P2SH when explicitly requested despite data fitting OP_RETURN', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend() // small data

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2SH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })
  })

  // ── B-8: Oversized OP_RETURN rejected ──────────────────────────

  describe('B-8: Oversized OP_RETURN rejected', () => {
    it('rejects forced OP_RETURN when data exceeds a single output', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // A transaction may carry at most one OP_RETURN output; Bitcoin Core
      // rejects multi-OP_RETURN transactions as non-standard at broadcast.
      // Forcing OP_RETURN with data larger than one 76-byte chunk must be
      // rejected at construction instead of building a PSBT that never relays.
      const bigData = 'X'.repeat(200)

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
