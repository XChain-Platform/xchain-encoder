// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A library caller that hands over UTXOs without a confirmations field gets the same
// treatment the API validator gives them: the field defaults to 0, so unconfirmed=false
// never spends an output whose confirmation state nobody stated.

'use strict'

const assert = require('assert')
const F = require('./helpers/build_fixture')

function spend (utxos, unconfirmed) {
  return F.create(F.makeEncoder('btc'), {
    utxos, unconfirmed, pubkey: F.p2pkhAddr('btc'), data: 'BROADCAST|0|0|x', encoding: 'OP_RETURN',
    change: F.p2pkhAddr('btc'), customOutputs: [{ address: F.otherAddr('btc'), value: 500000 }]
  })
}

describe('a UTXO with no confirmations field counts as unconfirmed', () => {
  it('unconfirmed=false skips it and spends a confirmed output instead', async () => {
    const unstated = F.makeUtxo('btc', 'p2wpkh', 9000000)
    delete unstated.confirmations
    const confirmed = F.makeUtxo('btc', 'p2wpkh', 1000000)
    const res = await spend([unstated, confirmed], false)
    assert.deepStrictEqual(F.inputTxids(res.psbt), [confirmed.txid])
  })

  it('unconfirmed=false with only such outputs reports no spendable UTXOs', async () => {
    const unstated = F.makeUtxo('btc', 'p2wpkh', 9000000)
    delete unstated.confirmations
    await assert.rejects(spend([unstated], false), (err) => err.xchainCode === 'NO_UTXOS')
  })

  it('leaves the caller UTXO objects as they were handed over', async () => {
    const unstated = F.makeUtxo('btc', 'p2wpkh', 9000000)
    delete unstated.confirmations
    const confirmed = F.makeUtxo('btc', 'p2wpkh', 1000000)
    await spend([unstated, confirmed], false)
    assert.ok(!('confirmations' in unstated), 'no confirmations field was written onto the caller object')
  })

  it('unconfirmed=true still spends it', async () => {
    const unstated = F.makeUtxo('btc', 'p2wpkh', 9000000)
    delete unstated.confirmations
    const res = await spend([unstated], true)
    assert.deepStrictEqual(F.inputTxids(res.psbt), [unstated.txid])
  })
})
