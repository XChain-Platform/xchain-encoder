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
const XChainEncoder = require('../../../src/XChainEncoder')

const DOGE = 'dogecoin-regtest'
const DOGE_NET = require('../../../src/build/crypto_networks').getBitcoinJsNetwork(DOGE)
const RATE_KB = 1000000
const FUNDING_INPUT = 2000000000
const pubkeyBuf = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
const CALLER = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: DOGE_NET }).address
const callerOutput = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest }).output

// One chunk fits a single leg; this payload needs several, all carried by the same funding tx.
const SINGLE_CHUNK_PAYLOAD = 'x'.repeat(400)
const MULTI_CHUNK_PAYLOAD = 'x'.repeat(3000)

function prevTxHex () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  for (let i = 0; i < 4; i++) tx.addOutput(callerOutput, FUNDING_INPUT)
  return tx.toHex()
}

function makeEncoder () {
  const encoder = new XChainEncoder(DOGE, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.01,
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async () => prevTxHex()
  }
  return encoder
}

function utxos () {
  return [0, 1, 2, 3].map(vout => ({
    txid: 'a'.repeat(64), vout, value: FUNDING_INPUT, confirmations: 6, scriptPubKey: callerOutput.toString('hex')
  }))
}

async function buildFunding (encoder, payload) {
  encoder.clearReservations()
  const res = await encoder.createTransaction(
    utxos(), CALLER, null, payload, null, null, false, 'P2SH', CALLER,
    null, null, null, true, RATE_KB)
  return res.psbt.__CACHE.__TX
}

async function buildReveal (encoder, fundingTx, payload) {
  const res = await encoder.createTransaction(
    [], CALLER, null, payload, null, null, false, 'P2SH', CALLER,
    fundingTx.getId(), fundingTx.toHex(), null, true, RATE_KB)
  return res.psbt.__CACHE.__TX
}

const isLeg = (o) => o.script.toString('hex').startsWith('a914')
const legs = (tx) => tx.outs.map((o, vout) => ({ o, vout })).filter(({ o }) => isLeg(o))
const sum = (outs) => outs.reduce((s, o) => s + o.value, 0)

describe('multi-chunk payload through a single P2SH fund tx @regression @tier1', () => {

  it('carries every chunk as its own leg of one funding transaction', async () => {
    const single = await buildFunding(makeEncoder(), SINGLE_CHUNK_PAYLOAD)
    const multi = await buildFunding(makeEncoder(), MULTI_CHUNK_PAYLOAD)
    assert.strictEqual(legs(single).length, 1, 'the one-chunk control must hold exactly one leg')
    assert.ok(legs(multi).length > 1, `a multi-chunk payload must hold several legs (${legs(multi).length})`)
    assert.strictEqual(multi.outs.filter(o => !isLeg(o)).length, 1, 'one change output, no second funding tx')
  })

  it('funds a distinct script per chunk so each leg can be revealed on its own', async () => {
    const multi = await buildFunding(makeEncoder(), MULTI_CHUNK_PAYLOAD)
    const scripts = new Set(legs(multi).map(({ o }) => o.script.toString('hex')))
    assert.ok(scripts.size > 1, 'chunks of differing content must not collapse onto one script')
  })

  it('is deterministic for the same inputs', async () => {
    const first = await buildFunding(makeEncoder(), MULTI_CHUNK_PAYLOAD)
    const second = await buildFunding(makeEncoder(), MULTI_CHUNK_PAYLOAD)
    assert.strictEqual(first.getId(), second.getId())
  })

  it('reveals by spending every funded leg in one transaction and keeping a value output', async () => {
    const encoder = makeEncoder()
    const funding = await buildFunding(encoder, MULTI_CHUNK_PAYLOAD)
    const reveal = await buildReveal(encoder, funding, MULTI_CHUNK_PAYLOAD)
    const fundedLegs = legs(funding)

    assert.strictEqual(reveal.ins.length, fundedLegs.length, 'one reveal input per funded leg')
    const spent = reveal.ins.map(i => `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`).sort()
    const expected = fundedLegs.map(({ vout }) => `${funding.getId()}:${vout}`).sort()
    assert.deepStrictEqual(spent, expected, 'the reveal must spend exactly the funding tx legs')

    const legTotal = sum(fundedLegs.map(({ o }) => o))
    const swept = sum(reveal.outs)
    assert.ok(swept > 0, 'the reveal must leave the caller a value output')
    assert.ok(swept < legTotal, 'the reveal must pay a fee out of the legs')
  })

  it('refuses a payload over the compiled size ceiling instead of splitting without bound', async () => {
    await assert.rejects(() => buildFunding(makeEncoder(), 'x'.repeat(9000)), /Payload too large/)
  })

})
