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
 * E2E-3: Encoding Type Selection & Boundaries
 *
 * Verifies auto-selection logic at size boundaries and forced encoding overrides.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  extractOpReturnPayload,
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

const NETWORK = 'dogecoin-regtest'

function stdUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

async function encode (data, opts = {}) {
  const network = opts.network || NETWORK
  const encoder = makeEncoder(network)
  const address = getTestAddress(network)
  const utxo = opts.utxo || stdUtxo()

  return encoder.createTransaction(
    [utxo], address, null,
    data, null, 10000, false, opts.encoding || null, address,
    null, null, opts.compressedPubKey || null, true, 0.00001
  )
}

describe('E2E-3: Encoding Type Selection & Boundaries', () => {

  describe('E2E-3.1: Minimum OP_RETURN (1-byte ACTION)', () => {
    it('single byte payload fits OP_RETURN', async () => {
      const result = await encode('X')
      assert.strictEqual(result.encoding, 'OP_RETURN')

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })
  })

  describe('E2E-3.2: Maximum OP_RETURN boundary (75-byte string)', () => {
    it('75-byte ACTION compiles to 76 bytes, fits OP_RETURN (76 + 4 magic = 80)', async () => {
      // script.compile([75-byte-buf]) = 1-byte push + 75 data = 76 bytes
      // 76 + 4 (XCHN) = 80 = OP_RETURN_SIZE → fits
      const action = actions.makeActionOfSize(75)
      const result = await encode(action.data)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  describe('E2E-3.3: One byte over OP_RETURN boundary', () => {
    it('80-byte ACTION exceeds OP_RETURN, auto-selects P2SH', async () => {
      const action = actions.makeActionOfSize(80)
      const result = await encode(action.data)
      assert.strictEqual(result.encoding, 'P2SH')
    })
  })

  describe('E2E-3.4: Forced OP_RETURN with large data is rejected', () => {
    it('200-byte data forced to OP_RETURN is rejected', async () => {
      // A transaction may carry at most one OP_RETURN output; Bitcoin Core
      // rejects multi-OP_RETURN transactions as non-standard at broadcast.
      // A payload larger than one 76-byte chunk must be rejected at
      // construction instead of producing a PSBT that never relays.
      // The rejection fires on every coin, not just bitcoin: singleOpReturnPolicy is
      // declared in the coin registry but read nowhere (uuid:0ca8479c).
      const bigData = 'X'.repeat(200)
      await assert.rejects(
        encode(bigData, { encoding: 'OP_RETURN', network: 'bitcoin-regtest' }),
        RangeError
      )
    })

    it('200-byte data on the auto path selects P2SH (the valid carrier)', async () => {
      const bigData = 'X'.repeat(200)
      const result = await encode(bigData)
      assert.strictEqual(result.encoding, 'P2SH')
    })
  })

  describe('E2E-3.5: Forced P2SH despite data fitting OP_RETURN', () => {
    it('encoding override to P2SH is honored', async () => {
      const action = actions.makeSend() // small
      const result = await encode(action.data, { encoding: 'P2SH' })
      assert.strictEqual(result.encoding, 'P2SH')

      // Should have P2SH output
      const p2shOutput = result.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160
      })
      assert.ok(p2shOutput, 'should have P2SH output')
    })
  })

  describe('E2E-3.6: Forced P2WSH', () => {
    it('encoding override to P2WSH produces witness output', async () => {
      const action = actions.makeFile()
      const result = await encode(action.data, {
        encoding: 'P2WSH',
        network: 'bitcoin-regtest'
      })
      assert.strictEqual(result.encoding, 'P2WSH')

      // P2WSH output: OP_0 <32-byte>
      const p2wshOutput = result.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_0 &&
               Buffer.isBuffer(d[1]) && d[1].length === 32
      })
      assert.ok(p2wshOutput, 'should have P2WSH output')
    })
  })

  describe('E2E-3.7: Forced MULTISIGN', () => {
    it('encoding override to MULTISIGN produces 1-of-3 multisig', async () => {
      const MS_DATA = 'A'.repeat(59)
      const result = await encode(MS_DATA, {
        encoding: 'MULTISIGN',
        compressedPubKey: PUBKEY_BUF.toString('hex'),
        utxo: makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      })
      assert.strictEqual(result.encoding, 'MULTISIGN')

      const encoder = makeEncoder(NETWORK)
      const msOutput = result.psbt.txOutputs.find(o => o.value === encoder.dustAmount)
      assert.ok(msOutput, 'should have multisig output at dust value')

      const decompiled = bitcoin.script.decompile(msOutput.script)
      assert.strictEqual(decompiled[0], bitcoin.opcodes.OP_1)
      assert.strictEqual(decompiled[4], bitcoin.opcodes.OP_3)
      assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_CHECKMULTISIG)
    })
  })

  describe('E2E-3.8: Near P2SH max chunk size', () => {
    it('400-byte data fits in single P2SH chunk', async () => {
      const data = 'Z'.repeat(400)
      const result = await encode(data, { encoding: 'P2SH' })
      assert.strictEqual(result.encoding, 'P2SH')

      // Count P2SH outputs
      const p2shOutputs = result.psbt.txOutputs.filter(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160
      })
      assert.strictEqual(p2shOutputs.length, 1, 'should fit in single P2SH chunk')
    })
  })

  describe('E2E-3.9: P2WSH handles larger-than-P2SH payload', () => {
    it('1000-byte file data splits across multiple P2WSH chunks', async () => {
      // Each data chunk is a single witness-script element, bound by consensus
      // MAX_SCRIPT_ELEMENT_SIZE (520) -> 476-byte capacity. A ~1050-byte file
      // therefore spans multiple P2WSH outputs, each a valid v0 witness program.
      const action = actions.makeFileLarge() // ~1050 bytes
      const result = await encode(action.data, {
        encoding: 'P2WSH',
        network: 'bitcoin-regtest'
      })
      assert.strictEqual(result.encoding, 'P2WSH')

      const p2wshOutputs = result.psbt.txOutputs.filter(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_0 &&
               Buffer.isBuffer(d[1]) && d[1].length === 32
      })
      assert.ok(p2wshOutputs.length >= 2,
        `~1050 bytes should split into multiple P2WSH chunks (got ${p2wshOutputs.length})`)
    })
  })
})
