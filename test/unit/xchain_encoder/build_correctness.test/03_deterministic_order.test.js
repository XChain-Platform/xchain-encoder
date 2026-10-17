// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Candidates are ordered by value, then txid, then vout, so the same UTXO set gives the
// same transaction whatever order the caller or the tracker listed it in.

'use strict'

const assert = require('assert')
const F = require('./helpers/build_fixture')
const { filterAndOrderUtxos } = require('../../../../src/XChainEncoder/build_transaction/input_candidates.js')

function spend (utxos) {
  return F.create(F.makeEncoder('btc'), {
    utxos, pubkey: F.p2pkhAddr('btc'), data: 'BROADCAST|0|0|x', encoding: 'OP_RETURN', change: F.p2pkhAddr('btc'),
    customOutputs: [{ address: F.otherAddr('btc'), value: 1000000 }]
  })
}

function unsignedHex (res) { return res.psbt.data.globalMap.unsignedTx.toBuffer().toString('hex') }

describe('candidate order is deterministic on equal values', () => {
  it('two equal-value UTXOs in either order build the same transaction', async () => {
    const a = F.makeUtxo('btc', 'p2wpkh', 5000000)
    const b = F.makeUtxo('btc', 'p2wpkh', 5000000)
    const first = await spend([{ ...a }, { ...b }])
    const second = await spend([{ ...b }, { ...a }])
    assert.strictEqual(unsignedHex(first), unsignedHex(second))
    assert.strictEqual(F.inputTxids(first.psbt)[0], [a.txid, b.txid].sort()[0], 'the lower txid leads a tie')
  })

  it('the order is value descending, then txid, then vout', () => {
    const t1 = '1'.repeat(64)
    const t2 = '2'.repeat(64)
    const build = {
      utxos: [
        { txid: t2, vout: 0, value: 700 }, { txid: t1, vout: 3, value: 700 }, { txid: t1, vout: 1, value: 700 },
        { txid: t2, vout: 5, value: 900 }, { txid: t1, vout: 0, value: 100 }
      ],
      unconfirmed: true, isReveal: false, exactInputs: false
    }
    filterAndOrderUtxos(build)
    assert.deepStrictEqual(build.utxos.map((u) => u.txid[0] + ':' + u.vout), ['2:5', '1:1', '1:3', '2:0', '1:0'])
  })

  it('every permutation of a set with ties builds one transaction', async () => {
    const base = [5, 5, 3, 5].map((v) => F.makeUtxo('btc', 'p2wpkh', v * 1000000))
    const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1], [3, 1, 2, 0]]
    const seen = new Set()
    for (const order of orders) seen.add(unsignedHex(await spend(order.map((i) => ({ ...base[i] })))))
    assert.strictEqual(seen.size, 1)
  })
})
