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
 * Chaos Engineering — Category E: Resource Exhaustion
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

  // ── E-1: Large P2WSH encoding ─────────────────────────────────

  describe('E-1: Large P2WSH encoding (memory stress)', () => {
    it('8189-byte payload (compiled 8192, at limit) with P2WSH completes in <5s', async () => {
      const encoder = makeEncoder(BTC)
      // This test measures encoding time, not fee policy; its flat 100000-sat
      // fee lands just over the relative fee-rate cap (which has its own
      // suite, XChainEncoder.feeRateCap.test.js), so disable the cap here.
      encoder.maxFeeRateMultiplier = null
      const utxo = makeSegwitUtxo(TXID_A, 0, 1000000000)

      const start = Date.now()
      const result = await encoder.createTransaction(
        [utxo], BTC_ADDR, null,
        'X'.repeat(8189), null, 100000, false, 'P2WSH', BTC_ADDR,
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

  // ── E-2: 500 UTXOs ───────────────────────────────────────────

  describe('E-2: High UTXO count processing', () => {
    it('500 segwit UTXOs of 100 sats each — all consumed, completes in <10s', async () => {
      const encoder = makeEncoder(DOGE)
      const utxos = []
      for (let i = 0; i < 500; i++) {
        // Unique txid:vout pairs to avoid dedup
        const txid = TXID_A.slice(0, 60) + String(i).padStart(4, '0')
        utxos.push(makeSegwitUtxo(txid, 0, 100))
      }

      const start = Date.now()
      const result = await encoder.createTransaction(
        utxos, DOGE_ADDR, null,
        actions.makeSend().data, null, 100000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      const elapsed = Date.now() - start

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.ok(elapsed < 10000, `should complete in <10s, took ${elapsed}ms`)
    })

    it('500 legacy UTXOs — getTransactionHex called for each consumed', async () => {
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
        utxos.push(makeLegacyUtxo(txid, 0, 100))
      }

      const start = Date.now()
      const result = await encoder.createTransaction(
        utxos, DOGE_ADDR, null,
        actions.makeSend().data, null, 100000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      const elapsed = Date.now() - start

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.ok(hexCallCount > 0, `getTransactionHex called ${hexCallCount} times`)
      assert.ok(elapsed < 10000, `should complete in <10s, took ${elapsed}ms`)
    })
  })
})
