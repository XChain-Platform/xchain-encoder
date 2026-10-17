// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The hub feeQuote output is added to the build's own output list. An in-process
// caller that reuses its customOutputs array for a second build must get the same
// transaction shape, not one extra fee output per earlier build.

const assert = require('assert')
const { paymentFor, utxoFor, makeEncoder, build } = require('../../../helpers/psbt_build_fixtures.js')

describe('XChainEncoder leaves the caller\'s customOutputs array alone', function () {
  it('builds twice from one array with one fee output each time', async function () {
    const prevTxs = new Map()
    const network = 'bitcoin-regtest'
    const pay = paymentFor('p2wpkh', network)
    const hub = paymentFor('p2pkh', network)
    const encoder = makeEncoder(network, { estimate: 0.00002, relayfee: 0.00001, prevTxs })
    const customOutputs = [{ address: pay.address, value: 10000 }]
    const request = (seed) => ({
      utxos: [utxoFor(prevTxs, pay.output, 1000000, seed)], pubkey: pay.address, data: 'BROADCAST|0|hi',
      encoding: 'OP_RETURN', change: pay.address, customOutputs, feeQuote: { address: hub.address, amount: 5000 }
    })
    const first = await build(encoder, request('first'))
    const second = await build(encoder, request('second'))
    assert.strictEqual(customOutputs.length, 1, 'the caller\'s array keeps its one payment')
    assert.strictEqual(second.psbt.txOutputs.length, first.psbt.txOutputs.length)
    assert.strictEqual(second.psbt.txOutputs.filter(o => o.script.equals(hub.output)).length, 1)
  })
})
