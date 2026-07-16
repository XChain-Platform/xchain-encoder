// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// : satoshi amounts above Number.MAX_SAFE_INTEGER (2^53-1, ~90.07M
// DOGE) through the validator, the PSBT construction, and the 64-bit wire
// serializers. Exact decimal STRINGS above 2^53-1 are carried as BigInt;
// already-lossy Numbers stay rejected (fail closed).

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder') // loads applyBufferutilsPatch
const {
  parseSatoshiAmount,
  validateUtxoEntry,
  validateCustomOutputs,
  MAX_SATOSHI_U64
} = require('../../src/validator')

const MAX_SAFE = Number.MAX_SAFE_INTEGER // 9007199254740991
const BIG_STR = '9007199254740993' // 2^53 + 1, not representable as Number
const HUGE_STR = '12000000000000000000' // 1.2e19, within u64 (u64 max ~1.8446e19)

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)

const DOGE_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('dogecoin-regtest')
const TEST_ADDRESS = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: DOGE_REGTEST }).address

function makeSegwitUtxo (txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest })
  return { txid, vout, value, confirmations: 6, scriptPubKey: p2wpkh.output.toString('hex') }
}

function makeEncoder () {
  const encoder = new XChainEncoder('dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => { throw new Error('not used in this suite') }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({ utxos: [] })
  }
  return encoder
}

describe(': large satoshi amounts (>2^53-1)', () => {

  // ── validator ────────────────────────────────────────────────────

  describe('parseSatoshiAmount', () => {
    it('still rejects a >2^53-1 string without allowBig (fail closed)', () => {
      assert.throws(() => parseSatoshiAmount(BIG_STR, 'v'), /exceeds the maximum safe satoshi amount/)
    })

    it('accepts a >2^53-1 exact decimal string with allowBig, returning BigInt', () => {
      assert.strictEqual(parseSatoshiAmount(BIG_STR, 'v', { allowBig: true }), 9007199254740993n)
      assert.strictEqual(parseSatoshiAmount(HUGE_STR, 'v', { allowBig: true }), 12000000000000000000n)
    })

    it('keeps returning Number for safe-range values with allowBig', () => {
      assert.strictEqual(parseSatoshiAmount('546', 'v', { allowBig: true }), 546)
      assert.strictEqual(parseSatoshiAmount(String(MAX_SAFE), 'v', { allowBig: true }), MAX_SAFE)
    })

    it('rejects an unsafe NUMBER even with allowBig (already rounded upstream)', () => {
      assert.throws(() => parseSatoshiAmount(MAX_SAFE + 2, 'v', { allowBig: true }), /pass amounts above it as an exact decimal string/)
    })

    it('rejects a value above the u64 wire ceiling', () => {
      const overU64 = (MAX_SATOSHI_U64 + 1n).toString()
      assert.throws(() => parseSatoshiAmount(overU64, 'v', { allowBig: true }), /maximum 64-bit satoshi amount/)
    })

    it('rejects negative and non-integer big strings', () => {
      assert.throws(() => parseSatoshiAmount('-' + BIG_STR, 'v', { allowBig: true }), /non-negative integer/)
      assert.throws(() => parseSatoshiAmount(BIG_STR + '.5', 'v', { allowBig: true }), /non-negative integer/)
    })
  })

  describe('validateUtxoEntry / validateCustomOutputs', () => {
    it('accepts a >2^53-1 utxo value string, coercing to BigInt', () => {
      const utxo = makeSegwitUtxo(TXID_A, 0, HUGE_STR)
      validateUtxoEntry(utxo, 0)
      assert.strictEqual(utxo.value, 12000000000000000000n)
    })

    it('accepts a >2^53-1 customOutputs value string, coercing to BigInt', () => {
      const outs = [{ address: TEST_ADDRESS, value: BIG_STR }]
      validateCustomOutputs(outs)
      assert.strictEqual(outs[0].value, 9007199254740993n)
    })
  })

  // ── PSBT construction end-to-end (no daemon) ─────────────────────

  describe('createTransaction', () => {
    it('builds a PSBT paying a >2^53-1-sat custom output with exact change', async () => {
      const encoder = makeEncoder()
      const inputValue = '12000000000000000000' // 1.2e19 sats in one UTXO
      const payValue = '11000000000000000001' // 1.1e19 + 1 sats out
      const fee = 100000
      const utxo = makeSegwitUtxo(TXID_A, 0, inputValue)
      validateUtxoEntry(utxo, 0)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, [{ address: TEST_ADDRESS, value: payValue }],
        'test', null, fee, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Round-trip through hex: the wire serializers must carry the value bit-exact.
      const hex = result.psbt.toHex()
      const reparsed = bitcoin.Psbt.fromHex(hex)
      const values = reparsed.txOutputs.map(o => BigInt(o.value))
      assert.ok(values.includes(11000000000000000001n), `pay output missing exactly; got ${values}`)
      const expectedChange = 12000000000000000000n - 11000000000000000001n - BigInt(fee)
      assert.ok(values.includes(expectedChange), `change ${expectedChange} missing exactly; got ${values}`)
    })

    it('accepts a >2^53-1-sat input paying small outputs (giant consolidation UTXO)', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, HUGE_STR)
      validateUtxoEntry(utxo, 0)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, [{ address: TEST_ADDRESS, value: 100000000 }],
        'test', null, 100000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )
      const reparsed = bitcoin.Psbt.fromHex(result.psbt.toHex())
      const values = reparsed.txOutputs.map(o => BigInt(o.value))
      const expectedChange = 12000000000000000000n - 100000000n - 100000n
      assert.ok(values.includes(expectedChange), `change ${expectedChange} missing exactly; got ${values}`)
    })

    it('reports insufficient funds with JSON-safe (stringified) big amounts', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000) // 1 coin in
      await assert.rejects(
        encoder.createTransaction(
          [utxo], TEST_ADDRESS, [{ address: TEST_ADDRESS, value: HUGE_STR }],
          'test', null, 100000, false, null, TEST_ADDRESS,
          null, null, null, true, 0.00001
        ),
        (err) => {
          assert.strictEqual(err.xchainCode, 'INSUFFICIENT_FUNDS')
          // metadata must survive JSON serialization (JSON-RPC error data)
          assert.doesNotThrow(() => JSON.stringify(err.details))
          assert.strictEqual(err.details.required, '12000000000000100000')
          return true
        }
      )
    })
  })

  // ── patched serializers stay correct in the safe range ───────────

  describe('patched 64-bit serializers', () => {
    it('round-trips safe-range values as Number and big values as BigInt', () => {
      const bufferutils = require('bitcoinjs-lib/src/bufferutils')
      const buf = Buffer.alloc(8)
      bufferutils.writeUInt64LE(buf, 546, 0)
      assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 546)
      bufferutils.writeUInt64LE(buf, 12000000000000000000n, 0)
      assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 12000000000000000000n)
    })

    it('rejects negative, fractional, and >u64 writes', () => {
      const bufferutils = require('bitcoinjs-lib/src/bufferutils')
      const buf = Buffer.alloc(8)
      assert.throws(() => bufferutils.writeUInt64LE(buf, -1, 0), /negative/)
      assert.throws(() => bufferutils.writeUInt64LE(buf, 1.5, 0), /fractional/)
      assert.throws(() => bufferutils.writeUInt64LE(buf, 0xffffffffffffffffn + 1n, 0), /out of range/)
    })
  })
})
