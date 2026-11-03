// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const { factory, DOGE, LTC, DOGE_ADDR } = require('./helpers')
const actions = require('../../../integration/helpers/actionFactory')
const { TXID_A, makeEncoder, makeLegacyUtxo, makeSegwitUtxo, attachPrevTxs } = factory

// Inputs that spend outputs of one parent share a single node fetch and parse per
// build. The value check stays per outpoint, and nothing is kept between builds.
const LTC_ADDR = factory.getTestAddress(LTC)
const VALUE = 5000000

function countFetches (encoder) {
  const counts = { total: 0 }
  const inner = encoder.connector.getTransactionHex
  encoder.connector.getTransactionHex = async (txid) => {
    counts.total++
    return inner(txid)
  }
  return counts
}

function sharedParent (make, n) {
  const utxos = []
  for (let vout = 0; vout < n; vout++) utxos.push(make(TXID_A, vout, VALUE))
  return utxos
}

// Exact-input mode spends every named outpoint, so N inputs of one parent are all walked.
function buildExact (encoder, utxos, addr, attachPrevTx) {
  return encoder.createTransaction(
    utxos, addr, null,
    actions.makeSend().data, null, 10000, false, null, addr,
    null, null, null, true, 0.00001, null, null, attachPrevTx, null, { exactInputs: true }
  )
}

const paths = [
  ['legacy', DOGE, makeLegacyUtxo, (e, u) => buildExact(e, u, DOGE_ADDR, false)],
  ['segwit attachPrevTx', LTC, makeSegwitUtxo, (e, u) => buildExact(e, u, LTC_ADDR, true)]
]

for (const [label, network, make, build] of paths) {
  describe(`prev-tx memo per build: ${label}`, () => {
    it('fetches a shared parent once, however many inputs spend it', async () => {
      const seen = []
      for (const n of [5, 20]) {
        const encoder = makeEncoder(network)
        const utxos = sharedParent(make, n)
        attachPrevTxs(encoder, utxos, network)
        const counts = countFetches(encoder)
        const result = await build(encoder, utxos)
        assert.strictEqual(result.psbt.data.inputs.length, n)
        seen.push(counts.total)
      }
      assert.deepStrictEqual(seen, [1, 1])
    })

    it('embeds the same parent bytes in every input', async () => {
      const encoder = makeEncoder(network)
      const utxos = sharedParent(make, 6)
      const hexByTxid = attachPrevTxs(encoder, utxos, network)
      const result = await build(encoder, utxos)
      for (const input of result.psbt.data.inputs) {
        assert.strictEqual(input.nonWitnessUtxo.toString('hex'), hexByTxid.get(TXID_A))
      }
    })

    it('still refuses a wrong stated value on a later input of the same parent', async () => {
      const encoder = makeEncoder(network)
      const utxos = sharedParent(make, 3)
      attachPrevTxs(encoder, utxos, network)
      // The first input matches (and warms the memo); the second understates its output.
      utxos[1] = make(TXID_A, 1, 1000)
      const counts = countFetches(encoder)
      await assert.rejects(() => build(encoder, utxos), (err) => {
        assert.match(err.message, new RegExp(`states value 1000 but the previous transaction pays ${VALUE}`))
        return true
      })
      assert.strictEqual(counts.total, 1)
    })

    it('does not share the memo between builds', async () => {
      const encoder = makeEncoder(network)
      const utxos = sharedParent(make, 2)
      attachPrevTxs(encoder, utxos, network)
      const counts = countFetches(encoder)
      const first = await build(encoder, utxos.map((u) => ({ ...u })))
      // Exact-input mode refuses outpoints still reserved, so free them for the second build.
      encoder.releaseReservation(first.reservation.id)
      await build(encoder, utxos.map((u) => ({ ...u })))
      assert.strictEqual(counts.total, 2)
    })
  })
}
