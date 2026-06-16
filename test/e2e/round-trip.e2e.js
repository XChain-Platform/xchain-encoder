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
 * E2E-9: Round-Trip Verification (Encoder-Decoder Consistency)
 *
 * Verifies that PSBTs produced by the encoder can be decoded back to the
 * original ACTION string, ensuring cross-service contract alignment.
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
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

function stdUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

describe('E2E-9: Round-Trip Verification', () => {

  // ── E2E-9.1: OP_RETURN SEND round-trip ────────────────────────

  describe('E2E-9.1: OP_RETURN SEND round-trip', () => {
    it('encode → extract → deobfuscate → decompile → exact match', async () => {
      const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC, 'test memo')
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = stdUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')

      // Step 1: Extract OP_RETURN output
      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      const scriptDecompiled = bitcoin.script.decompile(opReturnOutput.script)
      const obfuscatedData = scriptDecompiled[1]

      // Step 2: Deobfuscate with TXID
      const decrypted = deobfuscate(obfuscatedData, TXID_A)

      // Step 3: Verify magic word
      assert.strictEqual(decrypted.subarray(0, 4).toString('utf8'), MAGIC_WORD)

      // Step 4: Decompile the remaining data
      const payload = decrypted.subarray(4)
      const decompiled = decompilePayload(payload)

      // Step 5: Exact string match
      assert.strictEqual(decompiled[0].toString('utf8'), action.data)
    })
  })

  // ── E2E-9.2: P2SH ISSUE round-trip ───────────────────────────

  describe('E2E-9.2: P2SH ISSUE round-trip (all 25+ fields)', () => {
    it('all ISSUE fields survive P2SH tx1→tx2 round-trip', async () => {
      const action = actions.makeIssueFull('ROUNDTRIP', {
        maxSupply: '21000000',
        maxMint: '100',
        decimals: '8',
        description: 'Round-trip test token',
        memo: 'RT memo'
      })
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = stdUtxo()

      // tx1
      const tx1 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.strictEqual(tx1.encoding, 'P2SH')

      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      // tx2
      const tx2 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      // P2SH redeemScript: [data_chunk] OP_DROP OP_DUP OP_HASH160 ...
      // Data chunk is raw (unobfuscated) compiled ACTION script
      const input = tx2.psbt.data.inputs[0]
      const decompiled = bitcoin.script.decompile(input.redeemScript)
      const dataChunk = decompiled[0]

      const innerDecompiled = decompilePayload(dataChunk)
      const recoveredAction = innerDecompiled[0].toString('utf8')

      // Verify all fields present
      assert.strictEqual(recoveredAction, action.data)
      assert.ok(recoveredAction.includes('ROUNDTRIP'))
      assert.ok(recoveredAction.includes('21000000'))
      assert.ok(recoveredAction.includes('Round-trip test token'))
      assert.ok(recoveredAction.includes('RT memo'))
    })
  })

  // ── E2E-9.3: MULTISIGN round-trip ────────────────────────────

  describe('E2E-9.3: MULTISIGN round-trip', () => {
    it('data encoded in fake pubkeys recovers original payload', async () => {
      const MS_DATA = 'A'.repeat(59)
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const compressedPubKey = PUBKEY_BUF.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', address,
        null, null, compressedPubKey, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')

      const payload = extractMultisignPayload(result, TXID_MULTISIGN, encoder.dustAmount)
      assert.strictEqual(payload.magic, MAGIC_WORD)

      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled[0].toString('utf8'), MS_DATA)
    })
  })

  // ── E2E-9.4: P2WSH FILE round-trip ───────────────────────────

  describe('E2E-9.4: P2WSH FILE round-trip', () => {
    it('large file content survives P2WSH encoding', async () => {
      const action = actions.makeFileLarge()
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = stdUtxo()

      // tx1
      const tx1 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      // tx2
      const tx2 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      // P2WSH witnessScript: [data_chunk] OP_DROP OP_DUP OP_HASH160 ...
      // Data chunk is raw (unobfuscated) compiled ACTION script
      const input = tx2.psbt.data.inputs[0]
      const decompiled = bitcoin.script.decompile(input.witnessScript)
      const dataChunk = decompiled[0]

      const innerDecompiled = decompilePayload(dataChunk)
      assert.strictEqual(innerDecompiled[0].toString('utf8'), action.data)
    })
  })

  // ── E2E-9.5: Oversized OP_RETURN rejected ────────────────────

  describe('E2E-9.5: Oversized OP_RETURN rejected', () => {
    it('forced OP_RETURN beyond a single output is rejected', async () => {
      // A transaction may carry at most one OP_RETURN output; Bitcoin Core
      // rejects multi-OP_RETURN transactions as non-standard at broadcast.
      // A payload larger than one 76-byte chunk must be rejected at
      // construction. Large payloads round-trip via the P2SH path instead.
      const bigData = 'X'.repeat(200)
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
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

  // ── E2E-9.6: BATCH round-trip ────────────────────────────────

  describe('E2E-9.6: BATCH round-trip', () => {
    it('semicolon-separated batch survives encoding', async () => {
      const batch = actions.makeBatch([
        actions.makeSend('A', '1', actions.ADDR_BTC),
        actions.makeMint('B', '50'),
        actions.makeDestroy('C', '25')
      ])
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = stdUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        batch.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      if (result.encoding === 'OP_RETURN') {
        const payload = extractOpReturnPayload(result, TXID_A)
        assert.strictEqual(payload.magic, MAGIC_WORD)
        const decompiled = decompilePayload(payload.dataBuffer)
        const recovered = decompiled[0].toString('utf8')
        assert.strictEqual(recovered, batch.data)

        // Verify all three actions present with semicolons
        const parts = recovered.split(';')
        assert.strictEqual(parts.length, 3)
        assert.ok(parts[0].startsWith('SEND|'))
        assert.ok(parts[1].startsWith('MINT|'))
        assert.ok(parts[2].startsWith('DESTROY|'))
      } else {
        // If it spills to P2SH, just verify structural validity
        assert.strictEqual(result.encoding, 'P2SH')
        assert.ok(result.psbt.data.inputs.length >= 1)
      }
    })
  })

  // ── E2E-9.7: Cross-chain decode match ────────────────────────

  describe('E2E-9.7: Cross-chain decode equivalence', () => {
    it('same ACTION on BTC/DOGE/LTC produces identical decoded payloads', async () => {
      const action = actions.makeSend('XDOG', '50', 'mfWxJ45')
      const chains = ['bitcoin-regtest', 'dogecoin-regtest', 'litecoin-regtest']
      const decoded = []

      for (const chain of chains) {
        const encoder = makeEncoder(chain)
        const address = getTestAddress(chain)
        const utxo = stdUtxo()

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.strictEqual(result.encoding, 'OP_RETURN', `${chain} should use OP_RETURN`)

        const payload = extractOpReturnPayload(result, TXID_A)
        assert.strictEqual(payload.magic, MAGIC_WORD)

        const decompiled = decompilePayload(payload.dataBuffer)
        decoded.push(decompiled[0].toString('utf8'))
      }

      // All three chains should decode to the exact same ACTION string
      assert.strictEqual(decoded[0], decoded[1], 'BTC and DOGE should decode identically')
      assert.strictEqual(decoded[1], decoded[2], 'DOGE and LTC should decode identically')
      assert.strictEqual(decoded[0], action.data, 'decoded should match original ACTION')
    })
  })
})
