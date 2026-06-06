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
const XChainEncoder = require('../../src/XChainEncoder')

function makeEncoder () {
  return new XChainEncoder(
    'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
}

describe('XChainEncoder.dataToPubkey()', () => {
  let encoder

  beforeEach(() => {
    encoder = makeEncoder()
  })

  it('always returns exactly 33 bytes', async () => {
    for (const len of [1, 10, 16, 31, 32]) {
      const data = Buffer.alloc(len, 0xAB)
      const result = await encoder.dataToPubkey(data)
      assert.strictEqual(result.length, 33, `failed for input length ${len}`)
    }
  })

  it('first byte is always 0x02 (compressed pubkey prefix)', async () => {
    const data = Buffer.from([0xFF, 0xEE, 0xDD])
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result[0], 0x02)
  })

  it('data bytes are preserved starting at offset 1', async () => {
    const data = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])
    const result = await encoder.dataToPubkey(data)
    assert.deepStrictEqual(result.subarray(1, 1 + data.length), data)
  })

  it('pads with 0x00 when data is less than 32 bytes', async () => {
    const data = Buffer.from([0xAA, 0xBB])
    const result = await encoder.dataToPubkey(data)
    // Bytes 3..32 should be 0x00
    const padding = result.subarray(1 + data.length)
    assert.strictEqual(padding.length, 30)
    for (let i = 0; i < padding.length; i++) {
      assert.strictEqual(padding[i], 0x00, `padding byte at index ${i} is not 0x00`)
    }
  })

  it('no padding when data is exactly 32 bytes', async () => {
    const data = Buffer.alloc(32, 0xCC)
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
    assert.deepStrictEqual(result.subarray(1), data)
  })

  it('handles 1-byte input', async () => {
    const data = Buffer.from([0x42])
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
    assert.strictEqual(result[1], 0x42)
    // remaining 31 bytes are 0x00
    for (let i = 2; i < 33; i++) {
      assert.strictEqual(result[i], 0x00)
    }
  })

  it('handles empty input (0-byte buffer)', async () => {
    const data = Buffer.alloc(0)
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
    // all 32 remaining bytes are 0x00
    for (let i = 1; i < 33; i++) {
      assert.strictEqual(result[i], 0x00)
    }
  })
})
