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
const { factory, LTC, buildLtc, attachOnChainValues } = require('./helpers')
const { TXID_A, makeEncoder, makeSegwitUtxo, attachPrevTxs } = factory

// A hardware signer reads the amount from the attached prev tx, so the check
// runs wherever attachPrevTx already fetches it, and adds no fetch elsewhere.
describe('prev-out value check: segwit inputs', () => {
  it('refuses a mismatch when attachPrevTx fetches the previous transaction', async () => {
    const encoder = makeEncoder(LTC)
    const utxo = makeSegwitUtxo(TXID_A, 0, 1000000)
    attachOnChainValues(encoder, [utxo], 100000000, LTC)

    await assert.rejects(() => buildLtc(encoder, [utxo], true), (err) => {
      assert.ok(err instanceof RangeError)
      assert.match(err.message, /states value 1000000 but the previous transaction pays 100000000/)
      return true
    })
  })

  it('builds on a match with attachPrevTx', async () => {
    const encoder = makeEncoder(LTC)
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
    attachPrevTxs(encoder, [utxo], LTC)

    const result = await buildLtc(encoder, [utxo], true)
    assert.ok(Buffer.isBuffer(result.psbt.data.inputs[0].nonWitnessUtxo))
  })

  it('stays fetch-free without attachPrevTx (the sighash commits to the amount)', async () => {
    const encoder = makeEncoder(LTC)
    let fetched = 0
    encoder.connector.getTransactionHex = async () => {
      fetched++
      throw new Error('segwit without attachPrevTx must not fetch')
    }

    const result = await buildLtc(encoder, [makeSegwitUtxo(TXID_A, 0, 100000000)], false)
    assert.ok(result.psbt instanceof bitcoin.Psbt)
    assert.strictEqual(fetched, 0)
  })
})
