// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A key-path cancel suspends only where it waits on the node.
//
// The cancel claims its commit outpoint synchronously, then waits once for the
// relay floor and once for the node's fee rate. With a node that answers at
// once, the call settles four microtask turns after it is made: two for the
// node waits and one for each async return (the build into the public entry
// point, and the entry point into the caller). An extra async boundary shifts
// the settlement another turn after the claim, which changes when a failed
// cancel hands its outpoint back relative to a concurrent createTransaction.
// The count is pinned at four on both fee-rate paths and on the below-dust
// refusal.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainEncoder = require('../../../../src/XChainEncoder')

bitcoin.initEccLib(ecc)

const XONLY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const DESTINATION = bitcoin.payments.p2wpkh({
  pubkey: Buffer.from('02' + XONLY, 'hex'), network: bitcoin.networks.regtest
}).address

function makeEncoder () {
  const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getNetworkInfo: async () => ({ relayfee: 0.00001 })
  }
  return encoder
}

function recoveryRecord (commitValue, extra = {}) {
  return Object.assign({
    commitTxid: 'b'.repeat(64),
    commitVout: 0,
    commitValue,
    internalPubkey: XONLY,
    tapleafHash: 'c'.repeat(64),
    destination: DESTINATION
  }, extra)
}

// Counts microtask turns until the promise settles, one `await null` per turn.
async function turnsUntilSettled (promise) {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  let turns = 0
  while (!settled && turns < 100) {
    await null
    turns++
  }
  return turns
}

describe('XChainEncoder TAPROOT envelope', function () {
  describe('key-path cancel suspension count', function () {
    it('the node fee-rate path settles four turns after the call', async function () {
      const encoder = makeEncoder()
      const call = encoder.createEnvelopeCancelTransaction(recoveryRecord(100000))
      assert.strictEqual(await turnsUntilSettled(call), 4)
      assert.strictEqual((await call).cancel, true)
      assert.strictEqual(encoder.outpointReservations.size, 1)
    })

    it('the caller fee-rate path settles four turns after the call', async function () {
      const encoder = makeEncoder()
      const call = encoder.createEnvelopeCancelTransaction(recoveryRecord(100000, { feePerKb: 2000 }))
      assert.strictEqual(await turnsUntilSettled(call), 4)
      assert.strictEqual((await call).cancel, true)
    })

    it('a below-dust cancel is refused and hands its claim back four turns after the call', async function () {
      const encoder = makeEncoder()
      const call = encoder.createEnvelopeCancelTransaction(recoveryRecord(600))
      assert.strictEqual(await turnsUntilSettled(call), 4)
      await assert.rejects(call, err => err.xchainCode === 'ENVELOPE_CANCEL_BELOW_DUST')
      assert.strictEqual(encoder.outpointReservations.size, 0)
    })
  })
})
