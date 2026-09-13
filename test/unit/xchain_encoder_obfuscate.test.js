// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const crypto = require('crypto')
const XChainEncoder = require('../../src/XChainEncoder')

function makeEncoder () {
  return new XChainEncoder(
    'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
}

// Manually decrypt to verify round-trip
function deobfuscate (data, key) {
  const cipherKey = key.substr(0, 16)
  const iv = key.substr(16, 16)
  const decipher = crypto.createDecipheriv('aes-128-ctr', cipherKey, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

describe('XChainEncoder.obfuscate()', () => {
  let encoder
  // A fake txid (64 hex chars) with all distinct first 32 chars
  const TXID = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

  beforeEach(() => {
    encoder = makeEncoder()
  })

  it('produces output with same length as input (CTR mode)', async () => {
    const data = Buffer.from('Hello XChain Protocol')
    const encrypted = await encoder.obfuscate(data, TXID)
    assert.strictEqual(encrypted.length, data.length)
  })

  it('output differs from input (data is actually encrypted)', async () => {
    const data = Buffer.from('Hello XChain Protocol')
    const encrypted = await encoder.obfuscate(data, TXID)
    assert.notDeepStrictEqual(encrypted, data)
  })

  it('round-trips correctly (decrypt recovers original)', async () => {
    const data = Buffer.from('XCHN|SEND|1|ASSET|100')
    const encrypted = await encoder.obfuscate(data, TXID)
    const decrypted = deobfuscate(encrypted, TXID)
    assert.deepStrictEqual(decrypted, data)
  })

  it('is deterministic (same inputs produce same output)', async () => {
    const data = Buffer.from('deterministic test')
    const result1 = await encoder.obfuscate(data, TXID)
    const result2 = await encoder.obfuscate(data, TXID)
    assert.deepStrictEqual(result1, result2)
  })

  it('different keys produce different output', async () => {
    const data = Buffer.from('key sensitivity test')
    const key2 = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    const result1 = await encoder.obfuscate(data, TXID)
    const result2 = await encoder.obfuscate(data, key2)
    assert.notDeepStrictEqual(result1, result2)
  })

  it('uses first 16 hex chars as key and next 16 as IV', async () => {
    const data = Buffer.from('verify key/IV extraction')
    const cipherKey = TXID.substr(0, 16)
    const iv = TXID.substr(16, 16)

    // Encrypt manually with the same key/IV
    const cipher = crypto.createCipheriv('aes-128-ctr', cipherKey, iv)
    const expected = Buffer.concat([cipher.update(data), cipher.final()])

    const actual = await encoder.obfuscate(data, TXID)
    assert.deepStrictEqual(actual, expected)
  })

  it('handles 1-byte data', async () => {
    const data = Buffer.from([0x42])
    const encrypted = await encoder.obfuscate(data, TXID)
    assert.strictEqual(encrypted.length, 1)
    const decrypted = deobfuscate(encrypted, TXID)
    assert.deepStrictEqual(decrypted, data)
  })

  it('handles large data (several KB)', async () => {
    const data = Buffer.alloc(4096, 0)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const encrypted = await encoder.obfuscate(data, TXID)
    assert.strictEqual(encrypted.length, 4096)
    const decrypted = deobfuscate(encrypted, TXID)
    assert.deepStrictEqual(decrypted, data)
  })

  it('handles empty data (0 bytes)', async () => {
    const data = Buffer.alloc(0)
    const encrypted = await encoder.obfuscate(data, TXID)
    assert.strictEqual(encrypted.length, 0)
  })
})
