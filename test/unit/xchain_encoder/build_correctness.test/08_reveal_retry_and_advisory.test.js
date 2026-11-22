// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const { finishBuild } = require('../../../../src/XChainEncoder/build_transaction/build_result.js')
const { paymentFor, utxoFor, makeEncoder, build, unsignedTx } = require('../../../helpers/psbt_build_fixtures.js')

const NETWORK = 'bitcoin-regtest'

async function buildRevealTwice (encoding) {
  const prevTxs = new Map()
  const encoder = makeEncoder(NETWORK, { estimate: 0.0001, relayfee: 0.00001, prevTxs })
  const pay = paymentFor('p2wpkh', NETWORK)
  const common = {
    pubkey: pay.address,
    data: 'x'.repeat(1500),
    encoding,
    change: pay.address,
    feePerKb: 10000
  }
  const funding = await build(encoder, {
    ...common,
    utxos: [utxoFor(prevTxs, pay.output, 5000000, `retry-${encoding}`)]
  })
  const fundingTx = unsignedTx(funding)
  const revealArgs = {
    ...common,
    utxos: [],
    p2shHash: fundingTx.getId(),
    p2shHex: fundingTx.toHex()
  }
  const first = await build(encoder, revealArgs)
  const second = await build(encoder, revealArgs)
  return { encoder, first, second }
}

describe('claimless reveal retries', function () {
  for (const encoding of ['P2SH', 'P2WSH']) {
    it(`${encoding} returns the identical reveal again without a release ticket`, async function () {
      const { encoder, first, second } = await buildRevealTwice(encoding)
      const firstTxid = unsignedTx(first).getId()
      assert.strictEqual(unsignedTx(second).getId(), firstTxid)
      assert.strictEqual(first.reservation, undefined)
      assert.strictEqual(second.reservation, undefined)
      assert.strictEqual(encoder.recentBuilds.has(firstTxid), false)
    })
  }
})

describe('padded reveal burn-backstop advisory', function () {
  it('appends the tripwire message to caller-visible warnings', function () {
    const message = 'padded reveal fee 2000 exceeds the node-anchored burn ceiling 1000'
    const result = finishBuild.call({
      refuseDuplicateBuild: () => 'a'.repeat(64)
    }, {
      callReservations: [],
      psbt: {},
      preparedData: { encoding: 'OP_RETURN' },
      revealLegUndersizedMessage: 'reveal leg is undersized',
      revealFeeCeilingMessage: message
    })
    assert.deepStrictEqual(result.warnings.map(warning => warning.code), [
      'REVEAL_LEG_UNDERSIZED',
      'REVEAL_FEE_OVER_BACKSTOP'
    ])
    assert.strictEqual(result.warnings[1].message, message)
  })
})
