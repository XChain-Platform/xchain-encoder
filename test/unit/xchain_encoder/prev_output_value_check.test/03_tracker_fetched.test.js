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
const bitcoin = require('bitcoinjs-lib')
const { OperationalError } = require('../../../../src/build/errors')
const { factory, DOGE, buildDoge, attachOnChainValues } = require('./helpers')
const { TXID_A, makeEncoder, makeLegacyUtxo, makeTrackerEnvelope, attachPrevTxs } = factory

describe('prev-out value check: tracker-fetched and reservations', () => {
  it('refuses a tracker mismatch as UTXO_TRACKER_ERROR, not a caller RangeError', async () => {
    const encoder = makeEncoder(DOGE)
    const row = makeLegacyUtxo(TXID_A, 0, 1000000)
    encoder.utxoTrackerConnector = {
      getUtxosFromAddress: async () => makeTrackerEnvelope([Object.assign({}, row)])
    }
    attachOnChainValues(encoder, [row], 100000000, DOGE)

    await assert.rejects(() => buildDoge(encoder, null), (err) => {
      assert.ok(err instanceof OperationalError, `expected OperationalError, got ${err && err.name}`)
      assert.ok(!(err instanceof RangeError))
      assert.strictEqual(err.xchainCode, 'UTXO_TRACKER_ERROR')
      assert.ok(err.message.includes(`${TXID_A}:0`), err.message)
      return true
    })
  })

  it('a mismatch releases the outpoint, so a corrected retry succeeds at once', async () => {
    const encoder = makeEncoder(DOGE)
    const real = makeLegacyUtxo(TXID_A, 0, 100000000)
    attachPrevTxs(encoder, [real], DOGE)

    await assert.rejects(() => buildDoge(encoder, [makeLegacyUtxo(TXID_A, 0, 1000000)]), RangeError)
    assert.ok(!encoder.outpointReservations.has(`${TXID_A}:0`),
      'the refused build must not keep the outpoint reserved')

    const retry = await buildDoge(encoder, [real])
    assert.ok(retry.psbt instanceof bitcoin.Psbt)
  })
})
