// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression: chained sends from one wallet session built the SAME
// transaction twice.
//
// Measured live on BTC testnet4, 2026-08-27: three MINTs fired 1.2s apart from
// one validator address. The first built and broadcast; the second, ~800ms
// later, was handed the same input by the utxo-tracker (which had not yet seen
// the spend) and the encoder built a byte-identical transaction with the same
// txid, which the caller counted as a second success; the third failed.
//
// Root cause: the outpoint reservation map was only engaged for sets the
// encoder fetched from the tracker itself. The SDK fetches the funding set via
// get_utxos and passes it as `utxos`, so the mainstream wallet path was treated
// as "caller coin-control" and never reserved anything.
//
// Contract now: every selected input is reserved regardless of who fetched the
// set, a chained send that re-supplies a reserved input is refused with the
// reservation named as the cause, and a build identical to one produced inside
// the reservation window is refused even if the outpoint map was bypassed.

const assert = require('assert')
const {
  makeEncoder, makeSegwitUtxo, getTestAddress, TXID_A, TXID_B, TXID_C
} = require('../integration/helpers/utxoFactory')

const NETWORK = 'bitcoin-regtest'
const MINT = 'MINT|0|XCHAIN|10000'

function build (encoder, utxos, action = MINT) {
  const address = getTestAddress(NETWORK)
  return encoder.createTransaction(
    utxos, address, null, action, null, 10000, false, null, address,
    null, null, null, true, 0.00001
  )
}

function txidOf (result) {
  const bitcoin = require('bitcoinjs-lib')
  return bitcoin.Transaction.fromBuffer(result.psbt.data.globalMap.unsignedTx.toBuffer()).getId()
}

describe('REG-18: chained sends reserve caller-supplied inputs @regression', function () {
  this.timeout(10000)

  it('the measured shape: a second send re-supplying the spent input is refused, not rebuilt', async () => {
    const encoder = makeEncoder(NETWORK)
    // The tracker view a wallet hands over on a chained send: the previous
    // build's input is still listed because the spend has not reached it yet.
    const staleView = () => [makeSegwitUtxo(TXID_A, 0, 100000000)]

    const first = await build(encoder, staleView())
    const firstTxid = txidOf(first)

    await assert.rejects(
      () => build(encoder, staleView()),
      (err) => {
        assert.strictEqual(err.operational, true)
        assert.strictEqual(err.xchainCode, 'INSUFFICIENT_FUNDS')
        assert.strictEqual(err.details.reservedCandidates, 1)
        assert.match(err.message, /reserved by a transaction built in the last 5 minutes/)
        return true
      },
      'the second build must be refused with the reservation named, never returned as a second success'
    )

    // Nothing about the first build leaked or changed.
    assert.ok(encoder.outpointReservations.has(TXID_A + ':0'), 'the first build keeps its reservation')
    assert.ok(encoder.recentBuilds.has(firstTxid), 'the first build is on record')
  })

  it('three chained sends over a fresh view each produce three DISTINCT transactions', async () => {
    // The same guarantee at unit scale: chained sends whose views
    // reflect each prior spend select different inputs and hash differently.
    const encoder = makeEncoder(NETWORK)
    const r1 = await build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)])
    const r2 = await build(encoder, [makeSegwitUtxo(TXID_B, 0, 100000000)])
    const r3 = await build(encoder, [makeSegwitUtxo(TXID_C, 0, 100000000)])
    const txids = new Set([txidOf(r1), txidOf(r2), txidOf(r3)])
    assert.strictEqual(txids.size, 3, 'three chained sends must be three distinct transactions')
    assert.strictEqual(encoder.outpointReservations.size, 3, 'each selected input stays reserved')
  })

  it('a stale view that still lists the spent input alongside the change selects the change', async () => {
    const encoder = makeEncoder(NETWORK)
    await build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)])
    // Tracker now lists the old input AND the new change; the old one is reserved.
    const r2 = await build(encoder, [
      makeSegwitUtxo(TXID_A, 0, 100000000),
      makeSegwitUtxo(TXID_B, 1, 99000000)
    ])
    const ins = r2.psbt.txInputs.map(i => Buffer.from(i.hash).reverse().toString('hex'))
    assert.deepStrictEqual(ins, [TXID_B], 'the reserved input is skipped and the change is spent')
  })

  it('a different transaction over an unreserved input is not mistaken for a duplicate', async () => {
    const encoder = makeEncoder(NETWORK)
    await build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)], MINT)
    const r2 = await build(encoder, [makeSegwitUtxo(TXID_B, 0, 100000000)], 'MINT|0|XCHAIN|5000')
    assert.ok(r2.psbt, 'a genuinely different transaction builds')
  })

  it('an identical rebuild is refused as DUPLICATE_TRANSACTION when the outpoint map was bypassed', async () => {
    // Defense in depth: clear only the outpoint map (as a lapsed reservation
    // would) and rebuild byte-for-byte. The recent-build record still refuses it.
    const encoder = makeEncoder(NETWORK)
    const first = await build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)])
    encoder.outpointReservations.clear()

    await assert.rejects(
      () => build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)]),
      (err) => {
        assert.strictEqual(err.operational, true)
        assert.strictEqual(err.xchainCode, 'DUPLICATE_TRANSACTION')
        assert.strictEqual(err.details.txid, txidOf(first))
        return true
      }
    )
    // The refused rebuild hands back the reservation it took, so the map does
    // not squat on the outpoint for a build that never happened.
    assert.strictEqual(encoder.outpointReservations.size, 0)
  })

  it('an RBF bump of the same input is a different transaction and passes the duplicate gate', async () => {
    const encoder = makeEncoder(NETWORK)
    const address = getTestAddress(NETWORK)
    const utxo = () => makeSegwitUtxo(TXID_A, 0, 100000000)
    const first = await encoder.createTransaction([utxo()], address, null, MINT, null, 10000, true, null, address, null, null, null, true, 0.00001)
    // The bump deliberately respends the same input: only the outpoint map is
    // released (the operator's "wait out the TTL"), the recent-build record stays.
    encoder.outpointReservations.clear()
    const bump = await encoder.createTransaction([utxo()], address, null, MINT, null, 12000, true, null, address, null, null, null, true, 0.00001)
    assert.notStrictEqual(txidOf(bump), txidOf(first), 'a higher fee changes the outputs and the txid')
  })

  it('clearReservations releases both the outpoint map and the recent-build record', async () => {
    const encoder = makeEncoder(NETWORK)
    await build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)])
    encoder.clearReservations()
    assert.strictEqual(encoder.outpointReservations.size, 0)
    assert.strictEqual(encoder.recentBuilds.size, 0)
    const again = await build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)])
    assert.ok(again.psbt)
  })

  it('recent-build records expire with the reservation TTL', async () => {
    const encoder = makeEncoder(NETWORK)
    const first = await build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)])
    encoder.outpointReservations.clear()
    encoder.recentBuilds.set(txidOf(first), Date.now() - 1)
    const again = await build(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)])
    assert.strictEqual(txidOf(again), txidOf(first))
    assert.strictEqual(encoder.recentBuilds.size, 1, 'the expired record is evicted and the new one written')
  })
})
