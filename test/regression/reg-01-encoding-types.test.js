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
 * REG-01: Core Encoding Types
 *
 * Regression sentinel for all four encoding types (OP_RETURN, P2SH, P2WSH,
 * MULTISIGN). Verifies that each produces structurally valid PSBTs with
 * correctly embedded, decodable payloads.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  extractOpReturnPayload,
  extractMultisignPayload,
  decompilePayload,
  MAGIC_WORD
} = require('../integration/helpers/deobfuscate')
const {
  TXID_A,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const COMPRESSED_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('REG-01: Core Encoding Types', function () {

  // ── REG-01.1: OP_RETURN ───────────────────────────────────────

  describe('REG-01.1: OP_RETURN', function () {
    it('small SEND auto-selects OP_RETURN encoding', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('OP_RETURN output has value=0 and script starts with 0x6a', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(opReturnOutput, 'should have an OP_RETURN output')
      assert.strictEqual(opReturnOutput.script[0], bitcoin.opcodes.OP_RETURN)
    })

    it('deobfuscated payload starts with XCHN magic', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
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

    it('auto-selects OP_RETURN when compiled data + magic <= 80 bytes', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      // 75-byte data string → compiled = 76 bytes (1 push opcode + 75) + 4 magic = 80 → fits OP_RETURN
      const action = actions.makeActionOfSize(75)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  // ── REG-01.2: P2SH ────────────────────────────────────────────

  describe('REG-01.2: P2SH', function () {
    it('large ISSUE payload auto-selects P2SH', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })

    it('P2SH output has OP_HASH160 <20-byte-hash> OP_EQUAL structure', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const p2shOutput = result.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160
      })
      assert.ok(p2shOutput, 'should have a P2SH output')
      const d = bitcoin.script.decompile(p2shOutput.script)
      assert.ok(Buffer.isBuffer(d[1]) && d[1].length === 20, 'hash should be 20 bytes')
      assert.strictEqual(d[2], bitcoin.opcodes.OP_EQUAL)
    })

    it('P2SH output value >= dustAmount', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const p2shOutputs = result.psbt.txOutputs.filter(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160
      })

      for (const o of p2shOutputs) {
        assert.ok(o.value >= encoder.dustAmount,
          `P2SH output ${o.value} should be >= dust ${encoder.dustAmount}`)
      }
    })

    it('forced P2SH encoding respected even for small data', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend() // small enough for OP_RETURN

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2SH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })
  })

  // ── REG-01.3: P2WSH ───────────────────────────────────────────

  describe('REG-01.3: P2WSH', function () {
    it('P2WSH encoding accepted on bitcoin-regtest', async function () {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeFileLarge()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2WSH')
    })

    it('P2WSH output has OP_0 <32-byte-hash> structure', async function () {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeFileLarge()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      const p2wshOutput = result.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_0 &&
               Buffer.isBuffer(d[1]) && d[1].length === 32
      })
      assert.ok(p2wshOutput, 'should have a P2WSH output')
    })

    it('P2WSH rejected on dogecoin-regtest (no segwit)', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeFileLarge()

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, 'P2WSH', address,
          null, null, null, true, 0.00001
        ),
        { name: 'TypeError' }
      )
    })
  })

  // ── REG-01.4: MULTISIGN ───────────────────────────────────────

  describe('REG-01.4: MULTISIGN', function () {
    it('MULTISIGN produces 1-of-3 multisig output', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'MULTISIGN', address,
        null, null, COMPRESSED_PUBKEY, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')

      const msOutput = result.psbt.txOutputs.find(o => o.value === encoder.dustAmount)
      assert.ok(msOutput, 'should have a multisig output at dust value')

      const d = bitcoin.script.decompile(msOutput.script)
      // OP_1 <pk1> <pk2> <pk3> OP_3 OP_CHECKMULTISIG
      assert.strictEqual(d[0], bitcoin.opcodes.OP_1)
      assert.strictEqual(d[4], bitcoin.opcodes.OP_3)
      assert.strictEqual(d[5], bitcoin.opcodes.OP_CHECKMULTISIG)
    })

    it('third pubkey is the compressedPubKey argument', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'MULTISIGN', address,
        null, null, COMPRESSED_PUBKEY, true, 0.00001
      )

      const msOutput = result.psbt.txOutputs.find(o => o.value === encoder.dustAmount)
      const d = bitcoin.script.decompile(msOutput.script)
      assert.strictEqual(d[3].toString('hex'), COMPRESSED_PUBKEY)
    })

    it('deobfuscated MULTISIGN payload has XCHN prefix', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'MULTISIGN', address,
        null, null, COMPRESSED_PUBKEY, true, 0.00001
      )

      const payload = extractMultisignPayload(result, TXID_MULTISIGN, encoder.dustAmount)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })
  })

  // ── REG-01.5: Return shape ────────────────────────────────────

  describe('REG-01.5: Return shape', function () {
    it('result is { psbt, encoding } with Psbt instance', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt, 'result should have psbt')
      assert.ok(typeof result.encoding === 'string', 'encoding should be a string')
      assert.ok(typeof result.psbt.toHex === 'function', 'psbt should have toHex()')
    })

    it('psbt.toHex() produces a valid hex string', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const hex = result.psbt.toHex()
      assert.ok(hex.length > 0, 'hex should be non-empty')
      assert.ok(/^[0-9a-f]+$/i.test(hex), 'hex should only contain hex chars')
    })
  })
})
