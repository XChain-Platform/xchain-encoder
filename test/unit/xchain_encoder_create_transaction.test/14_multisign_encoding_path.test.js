// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
  assert,
  bitcoin,
  pubkeyBuf,
  TXID_MS,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

// MULTISIGN requires fake pubkeys that are valid EC points on secp256k1.
// dataToPubkey() prepends 0x02 and zero-pads to 33 bytes, but the x-coordinate
// must correspond to a real curve point. We use:
//   - TXID_MS: a brute-forced txid that produces valid points
//   - 'A'.repeat(59): data that compiles to exactly 60 bytes, producing a 64-byte
//     chunk (4 magic + 60 data), so both 32-byte slices are fully populated

const MS_DATA = 'A'.repeat(59) // compiles to 60 bytes → 64-byte chunk after XCHN prefix

describe('XChainEncoder.createTransaction()', () => {
  describe('MULTISIGN encoding path', () => {
    it('creates multisig output with correct structure', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')

      // Find the multisig output by its script shape (a bare p2ms script ends
      // in OP_CHECKMULTISIG). Its value is the relay-fee dust floor computed
      // from the actual script size, which is larger than the flat P2PKH
      // dustAmount (546), so we must not match on dustAmount here.
      const msOutput = result.psbt.txOutputs.find(o => {
        const d = bitcoin.script.decompile(o.script)
        return d && d[d.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG
      })
      assert.ok(msOutput, 'should have a bare-multisig output')
      assert.ok(msOutput.value >= encoder.dustAmount, 'multisig output value should be at least the dust floor')

      // Decompile the script to verify 1-of-3 structure
      const decompiled = bitcoin.script.decompile(msOutput.script)
      // OP_1 <pubkey1> <pubkey2> <pubkey3> OP_3 OP_CHECKMULTISIG
      assert.strictEqual(decompiled[0], bitcoin.opcodes.OP_1) // m = 1
      assert.ok(Buffer.isBuffer(decompiled[1])) // pubkey1
      assert.ok(Buffer.isBuffer(decompiled[2])) // pubkey2
      assert.ok(Buffer.isBuffer(decompiled[3])) // pubkey3
      assert.strictEqual(decompiled[4], bitcoin.opcodes.OP_3) // n = 3
      assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_CHECKMULTISIG)
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('MULTISIGN encoding path', () => {
    it('third pubkey is the real compressed public key', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey, true, 0.00001
      )

      const msOutput = result.psbt.txOutputs.find(o => {
        const d = bitcoin.script.decompile(o.script)
        return d && d[d.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG
      })
      assert.ok(msOutput, 'should have a bare-multisig output')
      const decompiled = bitcoin.script.decompile(msOutput.script)
      assert.deepStrictEqual(decompiled[3], pubkeyBuf)
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('MULTISIGN encoding path', () => {
    // The MULTISIGN data output carries real value (a relay-fee dust floor),
    // so that value MUST be counted toward the running output total before
    // change is computed. If it isn't, change is over-credited by exactly the
    // data-output value and total outputs exceed total inputs: bitcoinjs-lib
    // rejects the tx at extractTransaction ("Outputs are spending more than
    // Inputs") and the network rejects it as invalid.
    it('builds a valid tx where total outputs do not exceed inputs', async () => {
      const encoder = makeEncoder()
      const inputValue = 100000000
      const utxo = makeSegwitUtxo(TXID_MS, 0, inputValue)
      const compressedPubKey = pubkeyBuf.toString('hex')

      // A large dust value with a tiny fee is the exact condition that exposes
      // the bug: when the data-output value exceeds the fee, omitting it from
      // the output total over-credits change past the input total. fee=100,
      // dust=50000.
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA, null, 100, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey, true, 0.00001, 50000
      )

      const outputTotal = result.psbt.txOutputs.reduce((sum, o) => sum + o.value, 0)
      assert.ok(
        outputTotal <= inputValue,
        `total outputs (${outputTotal}) must not exceed total inputs (${inputValue})`
      )
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('MULTISIGN encoding path', () => {
    // A payload whose last chunk holds ≤28 data bytes produces a final
    // magic(4)+data buffer of ≤32 bytes. Before each chunk was padded to a
    // full 64-byte slot, obfuscatedData.slice(32) was empty, so dataToPubkey()
    // returned an all-zero x-coordinate (0x02 || 0x00×32), a secp256k1 x=0
    // point that p2ms() rejects at construction time, surfacing as a 500.
    // This payload compiles to 88 bytes → chunks of 60 + 28, exercising that
    // path end-to-end. TXID_MS_SHORT is brute-forced so every obfuscated
    // pubkey half across both chunks is a valid curve point.
    const TXID_MS_SHORT = '5efa379f1f220474a1c6d3114efb4bcac3e38d54e2003db334d1cb97c2f8bfba'
    const MS_DATA_SHORT = 'Z'.repeat(86) // compiles to 88 bytes → last chunk = magic(4) + 28

    it('encodes a short final chunk without throwing (x=0 pubkey regression)', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS_SHORT, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA_SHORT, null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')

      // Two MULTISIGN outputs (one per 64-byte chunk), each a well-formed
      // 1-of-3 p2ms script, proving both chunks' pubkey halves are valid points.
      const msOutputs = result.psbt.txOutputs.filter(o => {
        const d = bitcoin.script.decompile(o.script)
        return d && d[d.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG
      })
      assert.strictEqual(msOutputs.length, 2, 'should emit one MULTISIGN output per chunk')
      for (const out of msOutputs) {
        const decompiled = bitcoin.script.decompile(out.script)
        assert.strictEqual(decompiled[0], bitcoin.opcodes.OP_1)
        assert.strictEqual(decompiled[4], bitcoin.opcodes.OP_3)
        assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_CHECKMULTISIG)
      }
    })
  })
})
