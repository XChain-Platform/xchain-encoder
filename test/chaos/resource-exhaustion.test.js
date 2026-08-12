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
 * Chaos Engineering: Category E: Resource Exhaustion
 *
 * Tests encoder behavior under memory pressure (large payloads)
 * and high UTXO counts (500 legacy UTXOs requiring RPC calls).
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A, makeSegwitUtxo, makeLegacyUtxo,
  makeEncoder, getTestAddress, buildRawTxHex
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const BTC = 'bitcoin-regtest'
const DOGE = 'dogecoin-regtest'
const BTC_ADDR = getTestAddress(BTC)
const DOGE_ADDR = getTestAddress(DOGE)

describe('Chaos Category E: Resource Exhaustion', () => {

  describe('E-1: Large P2WSH encoding (memory stress)', () => {
    it('8189-byte payload (compiled 8192, at limit) with P2WSH completes in <5s', async () => {
      const encoder = makeEncoder(BTC)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1000000000)

      // This test measures encoding time, not fee policy. It used to pass a
      // flat 100000-sat fee and switch off the relative fee-rate cap
      // (maxFeeRateMultiplier = null) to get it past. That knob no longer
      // covers it: the absolute burn backstop is deliberately unconditional,
      // precisely so disabling the rate cap cannot open a drain, and 100000 sat
      // is over 100x the fair fee for this ~900-byte funding tx. Pay a fee that
      // a real caller could pay instead of disarming the guard. Fee policy has
      // its own suite (XChainEncoder.feeRateCap.test.js).
      const start = Date.now()
      const result = await encoder.createTransaction(
        [utxo], BTC_ADDR, null,
        'X'.repeat(8189), null, 20000, false, 'P2WSH', BTC_ADDR,
        null, null, null, true, 0.00001
      )
      const elapsed = Date.now() - start

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.strictEqual(result.encoding, 'P2WSH')
      assert.ok(elapsed < 5000, `should complete in <5s, took ${elapsed}ms`)
    })

    it('8193-byte payload exceeds limit → RangeError', async () => {
      const encoder = makeEncoder(BTC)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1000000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], BTC_ADDR, null,
          'X'.repeat(8193), null, 100000, false, 'P2WSH', BTC_ADDR,
          null, null, null, true, 0.00001
        ),
        /Payload too large/
      )
    })
  })

  // Both cases fund the 500 UTXOs at 1000 sats and set the fee to exactly the
  // 500-UTXO total. They were written at 100 sats against a fee of 100000,
  // which is a 50000-sat set trying to pay a 100000-sat fee: the pre-M-8
  // encoder built that PSBT anyway and these tests timed it. M-8 refuses an
  // under-funded selection, and refusing it early would have meant timing the
  // guard rather than the 500-input build this category exists to stress. The
  // fee is chosen so the shortfall only closes on the last UTXO, which keeps
  // "all 500 consumed" true and lands the build exactly on MAX_UTXO_COUNT.
  describe('E-2: High UTXO count processing', () => {
    it('500 segwit UTXOs, all consumed, completes in <10s', async () => {
      const encoder = makeEncoder(DOGE)
      const utxos = []
      for (let i = 0; i < 500; i++) {
        // Unique txid:vout pairs to avoid dedup
        const txid = TXID_A.slice(0, 60) + String(i).padStart(4, '0')
        utxos.push(makeSegwitUtxo(txid, 0, 1000))
      }

      const start = Date.now()
      const result = await encoder.createTransaction(
        utxos, DOGE_ADDR, null,
        actions.makeSend().data, null, 500000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      const elapsed = Date.now() - start

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.strictEqual(result.psbt.data.inputs.length, 500,
        'all 500 UTXOs should be consumed, at the MAX_UTXO_COUNT ceiling')
      assert.ok(elapsed < 10000, `should complete in <10s, took ${elapsed}ms`)
    })

    it('500 legacy UTXOs: getTransactionHex called for each consumed', async () => {
      const encoder = makeEncoder(DOGE)
      const rawHex = buildRawTxHex(100, DOGE)
      let hexCallCount = 0
      encoder.connector.getTransactionHex = async () => {
        hexCallCount++
        return rawHex
      }

      const utxos = []
      for (let i = 0; i < 500; i++) {
        const txid = TXID_A.slice(0, 60) + String(i).padStart(4, '0')
        utxos.push(makeLegacyUtxo(txid, 0, 1000))
      }

      const start = Date.now()
      const result = await encoder.createTransaction(
        utxos, DOGE_ADDR, null,
        actions.makeSend().data, null, 500000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      const elapsed = Date.now() - start

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.ok(hexCallCount > 0, `getTransactionHex called ${hexCallCount} times`)
      assert.ok(elapsed < 10000, `should complete in <10s, took ${elapsed}ms`)
    })
  })
})
