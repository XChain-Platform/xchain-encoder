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
const { factory, DOGE, DOGE_ADDR, buildDoge, sumOutputs, paidFee } = require('./helpers')
const { TXID_A, TXID_B, makeEncoder, makeLegacyUtxo, attachPrevTxs } = factory

describe('prev-out value check: legacy exact amounts', () => {
  it('builds on a matching value, and the fee math uses that exact amount', async () => {
    const encoder = makeEncoder(DOGE)
    const utxo = makeLegacyUtxo(TXID_A, 1, 100000000)
    attachPrevTxs(encoder, [utxo], DOGE)

    const result = await buildDoge(encoder, [utxo])
    const prev = bitcoin.Transaction.fromBuffer(result.psbt.data.inputs[0].nonWitnessUtxo)
    assert.strictEqual(BigInt(prev.outs[1].value), 100000000n)
    assert.strictEqual(sumOutputs(result.psbt) + paidFee(encoder), 100000000n,
      'outputs plus the paid fee must spend exactly the on-chain input')
  })

  it('names only the mismatched input in a multi-input build', async () => {
    const encoder = makeEncoder(DOGE)
    encoder.maxFeeRateMultiplier = null
    const good = makeLegacyUtxo(TXID_A, 0, 60000)
    const bad = makeLegacyUtxo(TXID_B, 2, 50000)
    attachPrevTxs(encoder, [good, Object.assign({}, bad, { value: 70000 })], DOGE)

    await assert.rejects(() => encoder.createTransaction(
      [good, bad], DOGE_ADDR, null, 'test', null, 90000, false, null, DOGE_ADDR,
      null, null, null, true, 0.00001
    ), (err) => {
      assert.ok(err instanceof RangeError)
      assert.ok(err.message.includes(`${TXID_B}:2`), err.message)
      assert.ok(!err.message.includes(`${TXID_A}:0`), err.message)
      return true
    })
  })

  it('compares above 2^53-1 exactly: a match builds, off by one is refused', async () => {
    const big = 9007199254740993n
    const encoder = makeEncoder(DOGE)
    const utxo = makeLegacyUtxo(TXID_A, 0, big)
    attachPrevTxs(encoder, [utxo], DOGE)
    const result = await buildDoge(encoder, [utxo])
    assert.strictEqual(sumOutputs(result.psbt) + paidFee(encoder), big)

    const encoder2 = makeEncoder(DOGE)
    attachPrevTxs(encoder2, [utxo], DOGE)
    await assert.rejects(() => buildDoge(encoder2, [makeLegacyUtxo(TXID_A, 0, big - 1n)]), (err) => {
      assert.ok(err instanceof RangeError)
      assert.match(err.message, /states value 9007199254740992 but the previous transaction pays 9007199254740993/)
      return true
    })
  })
})
