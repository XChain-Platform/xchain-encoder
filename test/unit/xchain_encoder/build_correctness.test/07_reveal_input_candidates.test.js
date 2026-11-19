// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict'

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { bindObfuscationKey } = require('../../../../src/XChainEncoder/build_transaction/first_input_key')
const {
  initInputState, gatherUtxos, filterAndOrderUtxos
} = require('../../../../src/XChainEncoder/build_transaction/input_candidates')

function revealBuild (overrides = {}) {
  return Object.assign({
    replacebyfee: false,
    p2shHash: null,
    p2shHex: null,
    options: {},
    utxos: [],
    unconfirmed: true,
    exactInputs: false,
    callReservations: []
  }, overrides)
}

describe('reveal builds do not reserve funding candidates', function () {
  it('marks both reveal shapes as skipping funding selection', function () {
    const p2sh = revealBuild({ p2shHash: 'a'.repeat(64) })
    const envelope = revealBuild({ options: { envelopeCommitHex: '00' } })
    initInputState(p2sh)
    initInputState(envelope)
    assert.strictEqual(p2sh.skipsInputSelection, true)
    assert.strictEqual(envelope.isTwoStepReveal, true)
    assert.strictEqual(envelope.skipsInputSelection, true)
  })

  it('binds a deterministic key without claiming an unused funding outpoint', function () {
    const claimed = []
    const encoder = {
      evictExpiredReservations () {},
      isOutpointReserved () { return false },
      claimOutpoint (reservations, key) { claimed.push(key); reservations.push({ key }) }
    }
    const build = revealBuild({
      p2shHash: 'b'.repeat(64),
      utxos: [{ txid: 'A'.repeat(64), vout: 0, value: 1000 }]
    })
    initInputState(build)
    bindObfuscationKey.call(encoder, build)
    assert.deepStrictEqual(claimed, [])
    assert.deepStrictEqual(build.callReservations, [])
    assert.strictEqual(build.txidFirstInput, 'a'.repeat(64))
  })

  it('does not query or require funding candidates for a two-step reveal', function () {
    const address = bitcoin.payments.p2pkh({ hash: Buffer.alloc(20, 1), network: bitcoin.networks.regtest }).address
    const build = revealBuild({ utxos: null, pubkey: address, options: { envelopeCommitHex: '00' } })
    initInputState(build)
    let calls = 0
    const encoder = {
      network: bitcoin.networks.regtest,
      utxoTrackerConnector: { getUtxosFromAddress: async () => { calls++; return { utxos: [] } } }
    }
    const gathered = gatherUtxos.call(encoder, build)
    assert.strictEqual(gathered.next().done, true)
    assert.deepStrictEqual(build.utxos, [])
    assert.strictEqual(calls, 0)
    assert.doesNotThrow(() => filterAndOrderUtxos(build))
  })
})
