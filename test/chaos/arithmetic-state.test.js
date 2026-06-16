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
 * Chaos Engineering — Category D: Arithmetic & State Corruption
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

  // ── D-1: Fee calculation overflow (silent fund loss) ──────────
  // BEHAVIORAL CONCERN: encoder returns "success" even when
  // changeSatoshis is negative. The excess goes to the miner.

  describe('D-1: Negative change = silent fund loss', () => {
    it('1-sat UTXO + 10000-sat fee → changeSatoshis=-9999, PSBT returned', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1)

      const result = await encoder.createTransaction(
        [utxo], ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )

      // Encoder does NOT throw — this is the silent fund loss scenario
      assert.ok(result.psbt instanceof bitcoin.Psbt)
      const changeOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(changeOutputs.length, 0,
        'negative change = no output added silently')
    })

    it('100-sat UTXOs with 10000-sat fee → all consumed, no throw', async () => {
      const encoder = makeEncoder(NETWORK)

      const result = await encoder.createTransaction(
        [
          makeSegwitUtxo(TXID_A, 0, 100),
          makeSegwitUtxo(TXID_B, 0, 100),
          makeSegwitUtxo(TXID_C, 0, 100)
        ],
        ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.strictEqual(result.psbt.data.inputs.length, 3,
        'all 3 UTXOs consumed despite being insufficient')
      const changeOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(changeOutputs.length, 0)
    })
  })

  // ── D-2: Insufficient UTXOs return PSBT as "success" ──────────

  describe('D-2: Insufficient UTXOs produce invalid PSBT', () => {
    it('total inputs < fee → PSBT returned with no error', async () => {
      const encoder = makeEncoder(NETWORK)

      // 3 UTXOs of 100 sats = 300 total. Fee = 10000. Need 10000+.
      const result = await encoder.createTransaction(
        [
          makeSegwitUtxo(TXID_A, 0, 100),
          makeSegwitUtxo(TXID_B, 0, 100),
          makeSegwitUtxo(TXID_A, 1, 100)
        ],
        ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.strictEqual(result.psbt.data.inputs.length, 3)
    })

    it('returned PSBT is structurally valid despite insufficient inputs', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100)

      const result = await encoder.createTransaction(
        [utxo], ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )

      // PSBT can be serialized to hex without error
      assert.doesNotThrow(() => result.psbt.toHex())
    })
  })

  // ── D-3: Concurrent state mutation ────────────────────────────

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

  // ── D-4: UTXO reuse / in-place mutation ───────────────────────

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

      // First call
      await encoder.createTransaction(
        utxos, ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )

      // Second call with already-sorted array
      const result2 = await encoder.createTransaction(
        utxos, ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )
      assert.ok(result2.psbt instanceof bitcoin.Psbt)
    })
  })
})
