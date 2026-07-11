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
// Regression coverage for the 2026-07-03 platform-stability deepdive encoder
// findings (M-5 through M-8, L-1, L-2). Each block pins the corrected behavior
// so a future refactor cannot silently reintroduce the bug.

// L-2 requires requiring src/api.js, which constructs an encoder from env at
// load time; set the minimum viable env BEFORE the require so construction
// succeeds without a live node. dotenv does not override already-set vars.
process.env.NETWORK = process.env.NETWORK || 'bitcoin-regtest'
process.env.NODE_URL = process.env.NODE_URL || '127.0.0.1'
process.env.NODE_PORT = process.env.NODE_PORT || '8332'
process.env.NODE_USER = process.env.NODE_USER || 'test'
process.env.NODE_PASSWORD = process.env.NODE_PASSWORD || 'test'

const assert = require('assert')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')

// P2SH forces the two-transaction flow (payload over the 76-byte OP_RETURN cap).
const BIG_DATA = 'x'.repeat(80)

describe('REG-09: 2026-07-03 deepdive encoder fixes', () => {

  // ── M-5: reveal derives inputs from phase 1, never re-queries the tracker ──
  describe('M-5: P2SH reveal does not re-query the UTXO tracker', () => {
    it('builds the reveal from p2shHex alone, even when the tracker would fail', async () => {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Phase 1 (funding) builds normally from the provided UTXO.
      const tx1 = await encoder.createTransaction(
        [utxo], address, null,
        BIG_DATA, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      // Now make the tracker fail hard: the reveal must never call it. Pass
      // utxos=null so the pre-fix code path would have queried the tracker and
      // stranded the reveal on the empty/failing view.
      let trackerCalled = false
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        throw new Error('tracker must not be queried on the reveal')
      }

      const tx2 = await encoder.createTransaction(
        null, address, null,
        BIG_DATA, null, 10000, false, null, address,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      assert.strictEqual(trackerCalled, false, 'reveal must not consult the tracker')
      assert.strictEqual(tx2.encoding, 'P2SH')
      assert.ok(tx2.psbt.data.inputs.length >= 1, 'reveal must reconstruct its inputs from phase 1')
    })
  })

  // ── M-6: sub-dust change is folded into the fee, never emitted ──
  describe('M-6: sub-dust change folding', () => {
    it('folds 1-sat change into the fee (no unbroadcastable dust output)', async () => {
      const encoder = makeEncoder('bitcoin-regtest') // dust = 546
      const address = getTestAddress('bitcoin-regtest')
      // change = 10000 - 9999 = 1 sat, below the 546 dust threshold
      const utxo = makeSegwitUtxo(TXID_A, 0, 10000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'test', null, 9999, false, null, address,
        null, null, null, true, 0.00001
      )

      const positive = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(positive.length, 0, '1-sat change must be folded into fee')
    })

    it('emits change exactly at the dust threshold, folds one sat below it', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')

      // change == dust (546): emitted.
      const atDust = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 10546)], address, null,
        'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(atDust.psbt.txOutputs.find(o => o.value === 546),
        'change equal to the dust threshold must be emitted')

      // change == dust - 1 (545): folded.
      const belowDust = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 10545)], address, null,
        'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.strictEqual(belowDust.psbt.txOutputs.filter(o => o.value > 0).length, 0,
        'change one sat below dust must be folded')
    })
  })

  // ── M-7: the 500-UTXO cap gates the SELECTED count, not the fetched set ──
  describe('M-7: MAX_UTXO_COUNT applies to selected inputs, not the fetched set', () => {
    it('builds from a tracker set larger than 500 UTXOs when a few inputs cover', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')

      // 600 fetched UTXOs; the largest (vout 0) alone covers the fee.
      const many = [makeSegwitUtxo(TXID_A, 0, 100000000)]
      for (let i = 1; i < 600; i++) many.push(makeSegwitUtxo(TXID_A, i, 50))
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: many })

      const result = await encoder.createTransaction(
        null, address, null,
        'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt.data.inputs.length >= 1,
        'a >500-UTXO address must remain spendable (no pre-selection cap)')
      assert.ok(result.psbt.data.inputs.length < 500,
        'largest-first selection should need only a few inputs here')
    })

    it('throws RangeError only when the SELECTED input count exceeds the limit', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')

      // 600 equal 50-sat UTXOs, fee 25000: covering it needs 501 inputs (>500).
      const small = []
      for (let i = 0; i < 600; i++) small.push(makeSegwitUtxo(TXID_A, i, 50))
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: small })

      await assert.rejects(
        () => encoder.createTransaction(
          null, address, null,
          'test', null, 25000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err instanceof RangeError && /selected input count/.test(err.message)
      )
    })
  })

  // ── M-8: under-funded selection throws a typed error, not a dead PSBT ──
  describe('M-8: insufficient-funds error', () => {
    it('throws INSUFFICIENT_FUNDS with a required/available payload', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 1000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'test', null, 5000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'INSUFFICIENT_FUNDS' &&
                 err.details.required === 5000 &&
                 err.details.available === 1000 &&
                 err.details.fee === 5000 &&
                 err.details.outputs === 0
      )
    })
  })

  // ── L-1: outpoint reservation prevents concurrent same-address double-spends ──
  describe('L-1: in-memory outpoint reservation', () => {
    function twoUtxoTracker (encoder) {
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: [
          makeSegwitUtxo(TXID_A, 0, 100000000),
          makeSegwitUtxo(TXID_A, 1, 100000000)
        ]
      })
    }

    it('two sequential tracker-fed selections pick disjoint outpoints', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      twoUtxoTracker(encoder)

      const r1 = await encoder.createTransaction(
        null, address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      const r2 = await encoder.createTransaction(
        null, address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.deepStrictEqual(r1.psbt.txInputs.map(i => i.index), [0])
      assert.deepStrictEqual(r2.psbt.txInputs.map(i => i.index), [1],
        'second call must skip the outpoint the first reserved')
    })

    it('once every outpoint is reserved a further call reports insufficient funds', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      twoUtxoTracker(encoder)

      await encoder.createTransaction(null, address, null, 'test', null, 10000, false, null, address, null, null, null, true, 0.00001)
      await encoder.createTransaction(null, address, null, 'test', null, 10000, false, null, address, null, null, null, true, 0.00001)

      await assert.rejects(
        () => encoder.createTransaction(null, address, null, 'test', null, 10000, false, null, address, null, null, null, true, 0.00001),
        (err) => err.operational === true && err.xchainCode === 'INSUFFICIENT_FUNDS'
      )

      // Releasing the reservations makes the outpoints selectable again.
      encoder.clearReservations()
      const r = await encoder.createTransaction(null, address, null, 'test', null, 10000, false, null, address, null, null, null, true, 0.00001)
      assert.deepStrictEqual(r.psbt.txInputs.map(i => i.index), [0])
    })

    it('caller-supplied UTXOs are never reserved (caller owns coin-control)', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Two back-to-back calls with the SAME explicit UTXO both succeed and both
      // select it: explicit coin-control is the caller's responsibility.
      const r1 = await encoder.createTransaction([utxo], address, null, 'test', null, 10000, false, null, address, null, null, null, true, 0.00001)
      const r2 = await encoder.createTransaction([utxo], address, null, 'test', null, 10000, false, null, address, null, null, null, true, 0.00001)
      assert.deepStrictEqual(r1.psbt.txInputs.map(i => i.index), [0])
      assert.deepStrictEqual(r2.psbt.txInputs.map(i => i.index), [0])
      assert.strictEqual(encoder.outpointReservations.size, 0, 'explicit UTXOs must not be reserved')
    })
  })

  // ── L-2: api.js forwards typed operational errors, sanitizes internals ──
  describe('L-2: API surfaces typed operational errors', () => {
    const { OperationalError } = require('../../src/errors')
    const { jsonRpcController, encoder } = require('../../src/api')
    const address = getTestAddress('bitcoin-regtest')

    it('forwards an OperationalError with code -32010 and a machine-readable reason', async () => {
      encoder.createTransaction = async () => {
        throw new OperationalError('INSUFFICIENT_FUNDS',
          'insufficient funds: selected inputs total 1000 but 5000 is required',
          { required: 5000, available: 1000 })
      }

      let caught
      try {
        await jsonRpcController.create_tx({ pubkey: address, data: 'SEND' })
      } catch (e) {
        caught = e
      }
      assert.ok(caught, 'create_tx should reject')
      assert.strictEqual(caught.code, -32010)
      assert.strictEqual(caught.data.reason, 'INSUFFICIENT_FUNDS')
      assert.strictEqual(caught.data.required, 5000)
      assert.strictEqual(caught.data.available, 1000)
      assert.ok(/insufficient funds/.test(caught.message))
    })

    it('collapses an unexpected internal error to a generic message (no leak)', async () => {
      encoder.createTransaction = async () => {
        // A transport error whose message embeds the internal node host:port.
        throw new Error('connect ECONNREFUSED 10.0.0.5:8332')
      }

      let caught
      try {
        await jsonRpcController.create_tx({ pubkey: address, data: 'SEND' })
      } catch (e) {
        caught = e
      }
      assert.ok(caught, 'create_tx should reject')
      assert.strictEqual(caught.code, -32603)
      assert.strictEqual(caught.message, 'Internal encoder error')
      assert.ok(!/10\.0\.0\.5/.test(caught.message), 'must not leak the internal host:port')
      assert.strictEqual(caught.data, undefined, 'internal errors carry no data payload')
    })
  })

  describe('FIX K: get_utxos validates the address param before the tracker call', () => {
    const { jsonRpcController } = require('../../src/api')

    it('rejects an object-valued address with code -32602', async () => {
      let caught
      try {
        await jsonRpcController.get_utxos({ address: { evil: true } })
      } catch (e) { caught = e }
      assert.ok(caught, 'get_utxos should reject a non-string address')
      assert.strictEqual(caught.code, -32602)
    })

    it('rejects an over-length (>100 char) address with code -32602', async () => {
      let caught
      try {
        await jsonRpcController.get_utxos({ address: 'x'.repeat(101) })
      } catch (e) { caught = e }
      assert.ok(caught, 'get_utxos should reject an over-length address')
      assert.strictEqual(caught.code, -32602)
    })
  })
})
