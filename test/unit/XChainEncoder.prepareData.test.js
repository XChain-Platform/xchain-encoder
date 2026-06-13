// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')

const MAGIC_WORD = 'XCHN'
const MAGIC_LEN = 4
const OP_RETURN_SIZE = 80
const P2SH_SIZE = 520
const PW2SH_SIZE = 520
const MULTISIGN_SIZE = 69

// A valid regtest P2PKH address for P2SH/P2WSH redeem script tests
const REGTEST_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'),
  network: bitcoin.networks.regtest
}).address

function makeEncoder () {
  return new XChainEncoder(
    'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
}

describe('XChainEncoder.prepareData()', () => {
  let encoder

  beforeEach(() => {
    encoder = makeEncoder()
  })

  // ── Auto-selection ───────────────────────────────────────────────

  describe('auto-selection (encoding = null/undefined)', () => {
    it('selects OP_RETURN when data fits within 76 bytes (80 - 4 magic)', () => {
      const data = Buffer.alloc(76) // exactly at limit
      const result = encoder.prepareData(data, undefined, REGTEST_ADDRESS)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('selects P2SH when data exceeds 76 bytes', () => {
      const data = Buffer.alloc(77)
      const result = encoder.prepareData(data, undefined, REGTEST_ADDRESS)
      assert.strictEqual(result.encoding, 'P2SH')
    })

    it('selects OP_RETURN for very small data (1 byte)', () => {
      const data = Buffer.from([0x42])
      const result = encoder.prepareData(data, undefined, REGTEST_ADDRESS)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('selects OP_RETURN for empty data', () => {
      const data = Buffer.alloc(0)
      const result = encoder.prepareData(data, undefined, REGTEST_ADDRESS)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  // ── OP_RETURN ────────────────────────────────────────────────────

  describe('OP_RETURN encoding', () => {
    it('produces a single chunk for data that fits', () => {
      const data = Buffer.from('Hello XChain')
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      assert.strictEqual(result.dataBufferArray.length, 1)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('prepends XCHN magic word to each chunk', () => {
      const data = Buffer.from('test')
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      const chunk = result.dataBufferArray[0]
      assert.strictEqual(chunk.subarray(0, 4).toString('utf8'), MAGIC_WORD)
    })

    it('data follows the magic word', () => {
      const data = Buffer.from('payload')
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      const chunk = result.dataBufferArray[0]
      assert.deepStrictEqual(chunk.subarray(MAGIC_LEN), data)
    })

    it('chunk size does not exceed OP_RETURN_SIZE (80 bytes)', () => {
      const data = Buffer.alloc(76) // max per chunk = 80 - 4 = 76
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      for (const chunk of result.dataBufferArray) {
        assert.ok(chunk.length <= OP_RETURN_SIZE,
          `chunk length ${chunk.length} exceeds ${OP_RETURN_SIZE}`)
      }
    })

    it('accepts a payload exactly at the 76-byte single-output limit', () => {
      const data = Buffer.alloc(OP_RETURN_SIZE - MAGIC_LEN) // 76 bytes
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      assert.strictEqual(result.dataBufferArray.length, 1)
    })

    it('rejects a payload one byte over the single-output limit', () => {
      // A transaction may carry at most one OP_RETURN output; Bitcoin Core
      // rejects multi-OP_RETURN transactions as non-standard. Payloads larger
      // than one 76-byte chunk must throw at construction rather than build a
      // PSBT that always fails to broadcast.
      const data = Buffer.alloc(OP_RETURN_SIZE - MAGIC_LEN + 1) // 77 bytes
      assert.throws(() => encoder.prepareData(data, 'OP_RETURN', null), RangeError)
    })

    it('rejects a payload spanning multiple chunks', () => {
      const data = Buffer.alloc(153, 0xAA)
      assert.throws(() => encoder.prepareData(data, 'OP_RETURN', null), RangeError)
    })

    it('pubKey is not used (null pubKey works)', () => {
      const data = Buffer.from('test')
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      assert.ok(result)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  // ── P2SH ─────────────────────────────────────────────────────────

  describe('P2SH encoding', () => {
    const chunkDataSize = P2SH_SIZE - 44 // 476

    it('produces compiled redeem scripts with correct opcodes', () => {
      const data = Buffer.alloc(100, 0xBB)
      const result = encoder.prepareData(data, 'P2SH', REGTEST_ADDRESS)
      const script = result.dataBufferArray[0]
      const decompiled = bitcoin.script.decompile(script)

      // data, OP_DROP, OP_DUP, OP_HASH160, pubkeyHash, OP_EQUALVERIFY, OP_CHECKSIG
      assert.ok(Buffer.isBuffer(decompiled[0]), 'first element is data buffer')
      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)
      assert.strictEqual(decompiled[2], bitcoin.opcodes.OP_DUP)
      assert.strictEqual(decompiled[3], bitcoin.opcodes.OP_HASH160)
      assert.ok(Buffer.isBuffer(decompiled[4]), 'fifth element is pubkey hash')
      assert.strictEqual(decompiled[4].length, 20)
      assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_EQUALVERIFY)
      assert.strictEqual(decompiled[6], bitcoin.opcodes.OP_CHECKSIG)
    })

    it('splits data into chunks of 476 bytes max', () => {
      const data = Buffer.alloc(chunkDataSize + 1, 0xCC) // needs 2 chunks
      const result = encoder.prepareData(data, 'P2SH', REGTEST_ADDRESS)
      assert.strictEqual(result.dataBufferArray.length, 2)
    })

    it('single chunk for data exactly at boundary', () => {
      const data = Buffer.alloc(chunkDataSize, 0xDD)
      const result = encoder.prepareData(data, 'P2SH', REGTEST_ADDRESS)
      assert.strictEqual(result.dataBufferArray.length, 1)
    })

    it('preserves all data across chunks', () => {
      const data = Buffer.alloc(1000, 0)
      for (let i = 0; i < data.length; i++) data[i] = i % 256
      const result = encoder.prepareData(data, 'P2SH', REGTEST_ADDRESS)

      const reassembled = Buffer.concat(
        result.dataBufferArray.map(script => {
          const decompiled = bitcoin.script.decompile(script)
          return decompiled[0] // first element is the data chunk
        })
      )
      assert.deepStrictEqual(reassembled, data)
    })
  })

  // ── P2WSH ────────────────────────────────────────────────────────

  describe('P2WSH encoding', () => {
    const chunkDataSize = PW2SH_SIZE - 44 // 476

    it('produces compiled redeem scripts same structure as P2SH', () => {
      const data = Buffer.alloc(100, 0xEE)
      const result = encoder.prepareData(data, 'P2WSH', REGTEST_ADDRESS)
      const script = result.dataBufferArray[0]
      const decompiled = bitcoin.script.decompile(script)

      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)
      assert.strictEqual(decompiled[6], bitcoin.opcodes.OP_CHECKSIG)
    })

    it('uses the same 476-byte chunk size as P2SH (bounded by the 520-byte push limit)', () => {
      // Each chunk is pushed as a SINGLE script element inside the witness
      // script, so it is bound by consensus MAX_SCRIPT_ELEMENT_SIZE (520),
      // exactly like P2SH — NOT by the larger total witness-script policy
      // limit. A 476-byte payload is the largest that fits one chunk.
      const data = Buffer.alloc(chunkDataSize, 0xFF)
      const result = encoder.prepareData(data, 'P2WSH', REGTEST_ADDRESS)
      assert.strictEqual(result.dataBufferArray.length, 1)
    })

    it('splits into multiple chunks when data exceeds 476 bytes', () => {
      const data = Buffer.alloc(chunkDataSize + 1, 0xAA)
      const result = encoder.prepareData(data, 'P2WSH', REGTEST_ADDRESS)
      assert.strictEqual(result.dataBufferArray.length, 2)
    })
  })

  // ── MULTISIGN ────────────────────────────────────────────────────

  describe('MULTISIGN encoding', () => {
    // MULTISIGN_SIZE(69) - MAGIC_LEN(4) - 1 - 1 - 1 - 1 - 1 = 60
    const chunkDataSize = MULTISIGN_SIZE - MAGIC_LEN - 1 - 1 - 1 - 1 - 1 // 60

    it('prepends XCHN magic word to each chunk', () => {
      const data = Buffer.from('multisig test')
      const result = encoder.prepareData(data, 'MULTISIGN', null)
      const chunk = result.dataBufferArray[0]
      assert.strictEqual(chunk.subarray(0, 4).toString('utf8'), MAGIC_WORD)
    })

    it('single chunk for data within limit', () => {
      const data = Buffer.alloc(chunkDataSize, 0x11)
      const result = encoder.prepareData(data, 'MULTISIGN', null)
      assert.strictEqual(result.dataBufferArray.length, 1)
    })

    it('multiple chunks for data exceeding limit', () => {
      const data = Buffer.alloc(chunkDataSize + 1, 0x22)
      const result = encoder.prepareData(data, 'MULTISIGN', null)
      assert.strictEqual(result.dataBufferArray.length, 2)
    })

    it('preserves all data across chunks (trailing pad is stripped on read)', () => {
      const data = Buffer.alloc(200, 0)
      for (let i = 0; i < data.length; i++) data[i] = i % 256
      const result = encoder.prepareData(data, 'MULTISIGN', null)

      // Each chunk is now zero-padded to a full 64-byte slot, so the final
      // chunk carries trailing pad after the real data. The reader recovers the
      // original payload via the compiled-script's self-describing length, so
      // here we assert the magic-stripped concatenation STARTS WITH the data
      // and the remainder is zero padding only.
      const reassembled = Buffer.concat(
        result.dataBufferArray.map(c => c.subarray(MAGIC_LEN))
      )
      assert.deepStrictEqual(reassembled.subarray(0, data.length), data)
      assert.ok(reassembled.subarray(data.length).every(b => b === 0),
        'bytes after the payload must be zero padding')
    })

    it('pubKey is not used (null pubKey works)', () => {
      const data = Buffer.from('test')
      const result = encoder.prepareData(data, 'MULTISIGN', null)
      assert.ok(result)
    })

    // ── Regression: multi-chunk last-chunk sizing ──────────────────
    // Every MULTISIGN output splits its 64 data bytes across two 32-byte
    // pubkey halves. A short final chunk used to leave the second half empty
    // or near-empty, so dataToPubkey() produced an all-zero / low-entropy EC
    // point that bitcoinjs-lib rejected ("Expected property 'pubkeys.1' of
    // type isPoint"). The encoder now zero-pads every chunk to a full 64-byte
    // slot, so both halves are always complete 32-byte values. These cases
    // exercise the previously-failing remainders.
    describe('regression: every chunk fills the full 64-byte slot', () => {
      const cases = [
        { compiled: 61,  chunks: 2, note: '1 data byte in last chunk (first multi-chunk boundary)' },
        { compiled: 88,  chunks: 2, note: 'last chunk = magic(4) + 28 = 32 bytes (pubkey2 would be empty before fix)' },
        { compiled: 120, chunks: 2, note: 'exact multiple of 60 — baseline, both chunks already full' }
      ]
      for (const { compiled, chunks, note } of cases) {
        it(`compiled=${compiled}: ${note}`, () => {
          const data = Buffer.alloc(compiled, 0xAB)
          const result = encoder.prepareData(data, 'MULTISIGN', null)
          assert.strictEqual(result.dataBufferArray.length, chunks,
            `compiled=${compiled} should produce ${chunks} chunks`)
          for (const chunk of result.dataBufferArray) {
            assert.strictEqual(chunk.length, 64,
              `every chunk must be a full 64-byte slot, got ${chunk.length}`)
          }
        })
      }
    })
  })

  // ── Invalid encoding ─────────────────────────────────────────────

  describe('invalid encoding', () => {
    it('throws TypeError for unrecognized encoding string', () => {
      const data = Buffer.from('test')
      assert.throws(
        () => encoder.prepareData(data, 'INVALID', null),
        { name: 'TypeError' }
      )
    })
  })
})
