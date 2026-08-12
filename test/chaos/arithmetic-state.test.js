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
 * Chaos Engineering: Category D: Arithmetic & State Corruption
 *
 * Tests fee calculation overflow, insufficient UTXOs producing
 * invalid PSBTs, concurrent state mutation, and UTXO array reuse.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A, TXID_B, TXID_C,
  makeSegwitUtxo, makeEncoder, getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'
const ADDRESS = getTestAddress(NETWORK)

describe('Chaos Category D: Arithmetic & State Corruption', () => {

  // These two cases were written against the pre-M-8 encoder, which returned
  // "success" when changeSatoshis came out negative: the caller signed a PSBT
  // whose outputs exceeded its inputs, and the excess went to the miner. M-8
  // (_buildTransaction) now rejects an under-funded selection with a typed
  // INSUFFICIENT_FUNDS error, so the chaos scenario is unchanged and only the
  // expected outcome moved: from a quietly-wrong PSBT to a loud refusal.

  const assertInsufficientFunds = (err) => {
    assert.strictEqual(err.xchainCode, 'INSUFFICIENT_FUNDS',
      `expected INSUFFICIENT_FUNDS, got ${err.xchainCode}: ${err.message}`)
    // The details carry what the caller needs to top up, so assert them rather
    // than the message text: available must be the real selected total, and
    // required must exceed it, or the guard fired on the wrong arithmetic.
    assert.ok(Number(err.details.required) > Number(err.details.available),
      'required must exceed available for this error to be the right one')
    return true
  }

  describe('D-1: Negative change is refused, not signed', () => {
    it('1-sat UTXO + 10000-sat fee → INSUFFICIENT_FUNDS, no PSBT', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        (err) => {
          assertInsufficientFunds(err)
          assert.strictEqual(Number(err.details.available), 1)
          return true
        }
      )
    })

    it('3x 100-sat UTXOs with 10000-sat fee → INSUFFICIENT_FUNDS on the whole set', async () => {
      const encoder = makeEncoder(NETWORK)

      await assert.rejects(
        () => encoder.createTransaction(
          [
            makeSegwitUtxo(TXID_A, 0, 100),
            makeSegwitUtxo(TXID_B, 0, 100),
            makeSegwitUtxo(TXID_C, 0, 100)
          ],
          ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        (err) => {
          assertInsufficientFunds(err)
          // All three were selected before the shortfall was declared, so the
          // guard is reporting the whole set's total and not giving up early.
          assert.strictEqual(Number(err.details.available), 300)
          return true
        }
      )
    })
  })

  describe('D-2: Insufficient UTXOs produce no PSBT', () => {
    it('total inputs < fee → rejected instead of returned', async () => {
      const encoder = makeEncoder(NETWORK)

      // 3 UTXOs of 100 sats = 300 total. Fee = 10000. Need 10000+.
      await assert.rejects(
        () => encoder.createTransaction(
          [
            makeSegwitUtxo(TXID_A, 0, 100),
            makeSegwitUtxo(TXID_B, 0, 100),
            makeSegwitUtxo(TXID_A, 1, 100)
          ],
          ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        assertInsufficientFunds
      )
    })

    it('a single dust UTXO is refused rather than serialized', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        assertInsufficientFunds
      )
    })

    it('a funded selection under the same chaos parameters still builds', async () => {
      // The other side of M-8: the shortfall check must key on the arithmetic,
      // not simply refuse every transaction these cases feed it.
      const encoder = makeEncoder(NETWORK)
      const result = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })

  describe('D-3: Concurrent calls with shared UTXO array', () => {
    it('two concurrent calls with independent arrays both succeed', async () => {
      const encoder = makeEncoder(NETWORK)

      const [r1, r2] = await Promise.all([
        encoder.createTransaction(
          [makeSegwitUtxo(TXID_A, 0, 100000000)],
          ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        encoder.createTransaction(
          [makeSegwitUtxo(TXID_B, 0, 100000000)],
          ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        )
      ])

      assert.ok(r1.psbt instanceof bitcoin.Psbt)
      assert.ok(r2.psbt instanceof bitcoin.Psbt)
    })

    it('two concurrent calls sharing same array both complete', async () => {
      const encoder = makeEncoder(NETWORK)
      const sharedUtxos = [
        makeSegwitUtxo(TXID_A, 0, 100000000),
        makeSegwitUtxo(TXID_B, 0, 50000000)
      ]

      // Both calls share the same array reference. JavaScript is
      // single-threaded so no true race, but the array is mutated.
      const [r1, r2] = await Promise.all([
        encoder.createTransaction(
          sharedUtxos, ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        encoder.createTransaction(
          sharedUtxos, ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        )
      ])

      assert.ok(r1.psbt instanceof bitcoin.Psbt)
      assert.ok(r2.psbt instanceof bitcoin.Psbt)
    })
  })

  describe('D-4: UTXO array mutation across calls', () => {
    it('createTransaction mutates the caller\'s utxos array in-place', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxos = [
        makeSegwitUtxo(TXID_C, 0, 10000000),   // small
        makeSegwitUtxo(TXID_A, 0, 100000000),  // large
        makeSegwitUtxo(TXID_B, 0, 50000000)    // medium
      ]
      const orderBefore = utxos.map(u => u.txid)

      await encoder.createTransaction(
        utxos, ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )

      const orderAfter = utxos.map(u => u.txid)
      // Array is now sorted largest-first: [TXID_A, TXID_B, TXID_C]
      assert.notDeepStrictEqual(orderBefore, orderAfter,
        'createTransaction mutates the utxos array (sort)')
    })

    it('second call with same pre-sorted array still succeeds', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxos = [
        makeSegwitUtxo(TXID_A, 0, 100000000),
        makeSegwitUtxo(TXID_B, 0, 50000000)
      ]

      await encoder.createTransaction(
        utxos, ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )

      const result2 = await encoder.createTransaction(
        utxos, ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )
      assert.ok(result2.psbt instanceof bitcoin.Psbt)
    })
  })
})
