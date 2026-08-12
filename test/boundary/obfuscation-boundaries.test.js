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
 * Obfuscation Boundary Tests
 *
 * Tests AES-128-CTR obfuscation edge cases: degenerate TXIDs, empty data,
 * single-byte data, and short TXIDs that produce invalid key/IV pairs.
 */

const assert = require('assert')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const {
  deobfuscate,
  extractOpReturnPayload,
  MAGIC_WORD
} = require('../integration/helpers/deobfuscate')

const NETWORK = 'dogecoin-regtest'

function makeTestEncoder () {
  return new XChainEncoder(
    'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
}

describe('Obfuscation Boundaries', () => {

  describe('unit-level: obfuscate()', () => {
    const encoder = makeTestEncoder()

    it('all-zero TXID produces valid obfuscated output', async () => {
      const zeroTxid = '0'.repeat(64)
      const data = Buffer.from('test data', 'utf8')
      const obfuscated = await encoder.obfuscate(data, zeroTxid)
      assert.ok(Buffer.isBuffer(obfuscated))
      assert.strictEqual(obfuscated.length, data.length)
    })

    it('all-zero TXID round-trips correctly', async () => {
      const zeroTxid = '0'.repeat(64)
      const data = Buffer.from('round trip test', 'utf8')
      const obfuscated = await encoder.obfuscate(data, zeroTxid)
      const deobfuscated = deobfuscate(obfuscated, zeroTxid)
      assert.deepStrictEqual(deobfuscated, data)
    })

    it('all-f TXID round-trips correctly', async () => {
      const fTxid = 'f'.repeat(64)
      const data = Buffer.from('hex boundary', 'utf8')
      const obfuscated = await encoder.obfuscate(data, fTxid)
      const deobfuscated = deobfuscate(obfuscated, fTxid)
      assert.deepStrictEqual(deobfuscated, data)
    })

    it('empty data returns empty buffer', async () => {
      const obfuscated = await encoder.obfuscate(Buffer.alloc(0), TXID_A)
      assert.strictEqual(obfuscated.length, 0)
    })

    it('1-byte data length is preserved and round-trips', async () => {
      const data = Buffer.from([0x42])
      const obfuscated = await encoder.obfuscate(data, TXID_A)
      assert.strictEqual(obfuscated.length, 1)
      const deobfuscated = deobfuscate(obfuscated, TXID_A)
      assert.deepStrictEqual(deobfuscated, data)
    })

    it('large data (10KB) round-trips correctly', async () => {
      const data = Buffer.alloc(10240, 0)
      for (let i = 0; i < data.length; i++) data[i] = i % 256
      const obfuscated = await encoder.obfuscate(data, TXID_A)
      assert.strictEqual(obfuscated.length, data.length)
      const deobfuscated = deobfuscate(obfuscated, TXID_A)
      assert.deepStrictEqual(deobfuscated, data)
    })
  })

  describe('short TXID causes AES failure', () => {
    const encoder = makeTestEncoder()

    it('TXID < 32 hex chars throws invalid IV error', async () => {
      const shortTxid = 'abcd1234' // only 8 chars
      const data = Buffer.from('test', 'utf8')

      await assert.rejects(
        () => encoder.obfuscate(data, shortTxid),
        (err) => {
          // Node.js crypto throws for invalid IV length
          return err.message.includes('Invalid initialization vector') ||
                 err.message.includes('invalid iv') ||
                 err.code === 'ERR_CRYPTO_INVALID_IV'
        }
      )
    })

    it('empty TXID throws', async () => {
      const data = Buffer.from('test', 'utf8')
      await assert.rejects(
        () => encoder.obfuscate(data, '')
      )
    })
  })

  describe('pipeline: all-zero TXID in first UTXO', () => {
    it('produces valid PSBT with deobfuscatable payload', async () => {
      const zeroTxid = '0'.repeat(64)
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const utxo = makeSegwitUtxo(zeroTxid, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|JDOG|1|addr', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.strictEqual(result.encoding, 'OP_RETURN')

      // Verify deobfuscation recovers the magic word
      const payload = extractOpReturnPayload(result, zeroTxid)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })
  })

  describe('pipeline: short TXID in first UTXO', () => {
    it('createTransaction throws during obfuscation step', async () => {
      const shortTxid = 'abcd'
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const utxo = makeSegwitUtxo(shortTxid, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'SEND|0|JDOG|1|addr', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )
      )
    })
  })
})
