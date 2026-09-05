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
 * Tracker-fetched UTXO above 2^53-1 satoshis, through the integration tier.
 *
 * The exact-decimal-string `value` on the tracker's records exists for exactly
 * this case: a DOGE consolidation output larger than Number.MAX_SAFE_INTEGER,
 * which validateUtxoEntry parses with { allowBig: true } into a BigInt and the
 * encoder's money path then carries as one. The integration tier's doubles used
 * to serve a JS Number `value`, so nothing here ever reached that branch and
 * only the conformance tier covered it.
 *********************************************************************/

const assert = require('assert')
const {
  TXID_A,
  makeSegwitUtxo,
  makeTrackerEnvelope,
  makeEncoder,
  getTestAddress
} = require('./helpers/utxoFactory')
const actions = require('./helpers/actionFactory')

const NETWORK = 'bitcoin-regtest'
// The same over-2^53-1 record the vendored conformance fixture carries.
const BIG_SATS = '9007199254740993'

describe('Category D: tracker-fetched UTXO above 2^53-1 satoshis', () => {

  it('selects a >2^53-1 tracker record without losing precision', async () => {
    const encoder = makeEncoder(NETWORK)
    const address = getTestAddress(NETWORK)
    const action = actions.makeSend()

    encoder.utxoTrackerConnector = {
      getUtxosFromAddress: async () => makeTrackerEnvelope([makeSegwitUtxo(TXID_A, 0, BIG_SATS)])
    }

    const result = await encoder.createTransaction(
      [], address, null,
      action.data, null, 10000, false, null, address,
      null, null, null, true, 0.00001
    )

    assert.strictEqual(result.psbt.data.inputs.length, 1)
    // The input reached the PSBT as a BigInt, which is the branch a Number
    // `value` on the double could never enter.
    assert.strictEqual(typeof result.psbt.data.inputs[0].witnessUtxo.value, 'bigint')
    assert.strictEqual(result.psbt.data.inputs[0].witnessUtxo.value, BigInt(BIG_SATS))

    const change = result.psbt.txOutputs.filter(o => o.value > 0)
    assert.strictEqual(change.length, 1)
    // Exact arithmetic, not an approximate magnitude check: a Number round-trip
    // through 9007199254740993 lands on ...992, so an input total that lost its
    // last satoshi shows up here as an off-by-one change value.
    assert.strictEqual(BigInt(change[0].value), BigInt(BIG_SATS) - 10000n)
  })

  it('reaches the freshness gate, which a sync-less envelope failed open past', async () => {
    // Proof the envelope is actually consulted: the same record behind a view
    // the tracker flags NOT synced must be refused before any input is chosen.
    // With the old `{ utxos }` stub `fetched.sync` was undefined and this path
    // could not be entered at all.
    const encoder = makeEncoder(NETWORK)
    const address = getTestAddress(NETWORK)
    const action = actions.makeSend()

    encoder.utxoTrackerConnector = {
      getUtxosFromAddress: async () => makeTrackerEnvelope(
        [makeSegwitUtxo(TXID_A, 0, BIG_SATS)], { synced: false }
      )
    }

    await assert.rejects(
      () => encoder.createTransaction(
        [], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      ),
      /stale/i
    )
  })

  it('serves the producer shape, not a simplified double', async () => {
    // Guard on the factory itself: if a record ever loses the exact-decimal
    // string or its amount/height/coinbase siblings, the test above would keep
    // passing on a record the tracker never emits.
    const record = makeSegwitUtxo(TXID_A, 0, BIG_SATS)
    assert.strictEqual(typeof record.value, 'string')
    assert.strictEqual(record.value, BIG_SATS)
    assert.strictEqual(record.amount, '90071992.54740993')
    assert.strictEqual(typeof record.height, 'number')
    assert.strictEqual(record.coinbase, false)

    const envelope = makeTrackerEnvelope([record])
    assert.ok(envelope.sync && typeof envelope.sync === 'object', 'the envelope carries the freshness sibling')
    assert.strictEqual(envelope.sync.synced, true)
  })
})
