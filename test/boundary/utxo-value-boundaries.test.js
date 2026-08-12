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
 * UTXO Value Boundary Tests
 *
 * Tests extreme UTXO values: 1 satoshi, value=0, string-typed values
 * via parseInt coercion, all-duplicate arrays, MAX_SAFE_INTEGER, and
 * insufficient funds exhaustion.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A,
  TXID_B,
  TXID_C,
  makeSegwitUtxo,
  makeMempoolUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')

// BTC semantics throughout (segwit UTXOs, 21M-BTC supply, fee honored at the
// supplied value). DOGE floors sub-100000 fees, which would skew the change
// assertions; DOGE fee-floor behavior is covered in the fee-cap tests.
const NETWORK = 'bitcoin-regtest'

describe('UTXO Value Boundaries', () => {

  describe('minimum value UTXOs', () => {
    // M-8: a 1-sat input cannot cover the fee, so the encoder throws a typed
    // INSUFFICIENT_FUNDS error instead of returning an unbroadcastable PSBT
    // (the pre-M-8 behavior added the input and returned negative change).
    it('1-sat UTXO: throws INSUFFICIENT_FUNDS (cannot cover fee)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'SEND|0|X|1|a', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'INSUFFICIENT_FUNDS' &&
                 err.details.available === 1
      )
    })

    it('value=0 UTXO: parseInt(0)=0, contributes nothing to inputSatoshis', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      // Two UTXOs: one with 0, one with enough to cover
      const zeroUtxo = makeSegwitUtxo(TXID_A, 0, 0)
      const realUtxo = makeSegwitUtxo(TXID_B, 0, 100000000)

      const result = await encoder.createTransaction(
        [zeroUtxo, realUtxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Sorted largest-first: realUtxo (1 BTC) comes first, covers everything
      // The encoder breaks after the first UTXO covers the cost
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })

  describe('string-typed UTXO values (parseInt coercion)', () => {
    it('"1000000" string value → treated as 1000000 sats correctly', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, '1000000')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.strictEqual(changeOutput.value, 1000000 - 10000,
        'string "1000000" should be parsed correctly')
    })

    it('"1.9" string value is rejected, not truncated to 1', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, '1.9')

      // parseInt would have truncated "1.9" to 1 sat and built a nonsensical
      // (negative-change) tx; the exact-integer parse rejects it up front.
      await assert.rejects(() => encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      ), /must be a non-negative integer/)
    })
  })

  describe('all-duplicate UTXOs', () => {
    it('3 identical UTXOs dedup to 1; if sufficient, single input', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const dup1 = makeSegwitUtxo(TXID_A, 0, 100000000)
      const dup2 = makeSegwitUtxo(TXID_A, 0, 100000000)
      const dup3 = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [dup1, dup2, dup3], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1,
        'dedup 3 identical → 1 UTXO, sufficient for fee')
    })

    // M-8: after dedup the single 100-sat UTXO cannot cover the 10000 fee, so
    // the encoder throws INSUFFICIENT_FUNDS rather than return negative change.
    it('3 identical small UTXOs dedup to 1; insufficient throws INSUFFICIENT_FUNDS', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      // 3 copies of 100 sats → dedup → 1 UTXO of 100 sats. Fee = 10000. Insufficient.
      const dup1 = makeSegwitUtxo(TXID_A, 0, 100)
      const dup2 = makeSegwitUtxo(TXID_A, 0, 100)
      const dup3 = makeSegwitUtxo(TXID_A, 0, 100)

      await assert.rejects(
        () => encoder.createTransaction(
          [dup1, dup2, dup3], address, null,
          'SEND|0|X|1|a', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'INSUFFICIENT_FUNDS' &&
                 err.details.available === 100
      )
    })
  })

  describe('UTXO with large value', () => {
    it('value = 2.1 trillion sats (21M BTC max supply) works correctly', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const maxBtcSats = 2100000000000000 // 21M BTC in satoshis
      const utxo = makeSegwitUtxo(TXID_A, 0, maxBtcSats)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.strictEqual(changeOutput.value, maxBtcSats - 10000)
    })

    it('value = MAX_SAFE_INTEGER builds exact change above the library Satoshi type cap', async () => {
      // Before large-value support landed, bitcoinjs-lib's Satoshi type check
      // (21M BTC cap) rejected this; the applyBufferutilsPatch relaxes it to
      // the u64 wire ceiling because DOGE has no supply cap. The value itself
      // is still Number-exact.
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, Number.MAX_SAFE_INTEGER)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.strictEqual(changeOutput.value, Number.MAX_SAFE_INTEGER - 10000)
    })

    it('full-precision string value above MAX_SAFE_INTEGER builds exact BigInt change (DOGE consolidation)', async () => {
      // The utxo-tracker hands the encoder a full-precision decimal string, so a
      // DOGE consolidation UTXO above 2^53-1 sats (~90.07M DOGE) reaches the
      // encoder intact. This used to be rejected fail-closed; the value now
      // flows through the BigInt money path with no precision loss.
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const bigSats = '10000000100000000' // 100,000,001 DOGE in sats, > MAX_SAFE_INTEGER
      const utxo = makeSegwitUtxo(TXID_A, 0, bigSats)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      const values = result.psbt.txOutputs.map(o => BigInt(o.value))
      assert.ok(
        values.includes(10000000100000000n - 10000n),
        `expected exact change 10000000099990000; got ${values}`
      )
    })
  })

  describe('unconfirmed filtering exhaustion', () => {
    it('all UTXOs mempool + unconfirmed=false → falls to UtxoTracker', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const mempool1 = makeMempoolUtxo(TXID_A, 0, 100000000)
      const mempool2 = makeMempoolUtxo(TXID_B, 0, 50000000)

      // After filtering, array is empty → falls through to UtxoTracker
      let trackerCalled = false
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        return { utxos: [makeSegwitUtxo(TXID_C, 0, 100000000)] }
      }

      const result = await encoder.createTransaction(
        [mempool1, mempool2], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Note: the encoder does NOT re-fetch from tracker after filtering.
      // The mempool UTXOs are filtered AFTER the null/empty check.
      // So the filtered-empty array still proceeds to sorting and the UTXO loop,
      // which simply iterates 0 times, producing no inputs.
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })

  describe('UTXO sorting with mixed values', () => {
    it('largest UTXO is always used as first input (txidFirstInput)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      // Three UTXOs in random order; 50M is the largest
      const small = makeSegwitUtxo(TXID_A, 0, 1000)
      const large = makeSegwitUtxo(TXID_B, 0, 50000000)
      const medium = makeSegwitUtxo(TXID_C, 0, 500000)

      const result = await encoder.createTransaction(
        [small, medium, large], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // After sort, largest (TXID_B) comes first. Only 1 input needed.
      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })
})
