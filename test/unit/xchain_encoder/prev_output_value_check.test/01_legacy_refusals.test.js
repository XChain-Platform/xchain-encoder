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
const { factory, DOGE, buildDoge, attachOnChainValues } = require('./helpers')
const { TXID_A, makeEncoder, makeLegacyUtxo, attachPrevTxs } = factory

describe('prev-out value check: legacy refusals (caller-supplied)', () => {
  it('refuses an understated value with a RangeError naming the outpoint and both amounts', async () => {
    const encoder = makeEncoder(DOGE)
    const utxo = makeLegacyUtxo(TXID_A, 0, 1000000)
    attachOnChainValues(encoder, [utxo], 100000000, DOGE)

    await assert.rejects(() => buildDoge(encoder, [utxo]), (err) => {
      assert.ok(err instanceof RangeError, `expected RangeError, got ${err && err.name}`)
      assert.ok(err.message.includes(`${TXID_A}:0`), err.message)
      assert.match(err.message, /states value 1000000 but the previous transaction pays 100000000/)
      return true
    })
  })

  it('refuses an overstated value', async () => {
    const encoder = makeEncoder(DOGE)
    const utxo = makeLegacyUtxo(TXID_A, 0, 100000001)
    attachOnChainValues(encoder, [utxo], 100000000, DOGE)

    await assert.rejects(() => buildDoge(encoder, [utxo]), (err) => {
      assert.ok(err instanceof RangeError)
      assert.match(err.message, /states value 100000001 but the previous transaction pays 100000000/)
      return true
    })
  })

  it('refuses a vout past the end of the previous transaction', async () => {
    const encoder = makeEncoder(DOGE)
    // The prev tx only has outputs 0..1.
    attachPrevTxs(encoder, [makeLegacyUtxo(TXID_A, 1, 100000000)], DOGE)

    await assert.rejects(() => buildDoge(encoder, [makeLegacyUtxo(TXID_A, 3, 100000000)]), (err) => {
      assert.ok(err instanceof RangeError)
      assert.match(err.message, new RegExp(`${TXID_A}:3 has no output at index 3`))
      return true
    })
  })

  it('refuses an undecodable previous transaction', async () => {
    const encoder = makeEncoder(DOGE)
    encoder.connector.getTransactionHex = async () => 'deadbeef'

    await assert.rejects(() => buildDoge(encoder, [makeLegacyUtxo(TXID_A, 0, 100000000)]), (err) => {
      assert.ok(err instanceof RangeError)
      assert.match(err.message, /has no output at index 0/)
      return true
    })
  })
})
