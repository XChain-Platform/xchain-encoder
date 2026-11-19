// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  ECPair, networkOf, utxoFor, makeEncoder
} = require('../../../helpers/psbt_build_fixtures.js')
const { MAX_STANDARD_TX_WEIGHT } = require('../../../../src/common/validator')

const NETWORK = 'bitcoin-regtest'
const FEE = 400000

function privateKey (value) {
  const key = Buffer.alloc(32)
  key.writeUInt32BE(value, 28)
  return ECPair.fromPrivateKey(key)
}

function fixture (count) {
  const network = networkOf(NETWORK)
  const keys = [privateKey(1), privateKey(2), privateKey(3)]
  const redeem = bitcoin.payments.p2ms({
    m: 2, pubkeys: keys.map(key => Buffer.from(key.publicKey)), network
  })
  const funding = bitcoin.payments.p2sh({ redeem, network })
  const destination = bitcoin.payments.p2wsh({
    redeem: { output: bitcoin.script.compile([bitcoin.opcodes.OP_TRUE]) }, network
  })
  const prevTxs = new Map()
  const utxos = []
  for (let i = 0; i < count; i++) {
    const utxo = utxoFor(prevTxs, funding.output, 1000000, `weight-ceiling-${i}`)
    utxo.redeemScript = redeem.output.toString('hex')
    utxos.push(utxo)
  }
  return { keys, funding, destination, prevTxs, utxos }
}

function buildExact (setup) {
  const encoder = makeEncoder(NETWORK, {
    estimate: 0.00002, relayfee: 0.00001, prevTxs: setup.prevTxs
  })
  return encoder.createTransaction(
    setup.utxos, setup.funding.address,
    [{ address: setup.destination.address, value: 100000 }], null, null,
    FEE, false, null, setup.destination.address, null, null, null,
    true, null, null, null, false, null, { exactInputs: true })
}

describe('legacy P2SH multisig funding weight ceiling', function () {
  this.timeout(30000)

  it('refuses an exact-input build above the standard transaction weight', async function () {
    await assert.rejects(buildExact(fixture(500)),
      /estimated transaction weight .* exceeds the standard limit/)
  })

  it('allows and signs a large build whose final weight stays below the limit', async function () {
    const setup = fixture(300)
    const result = await buildExact(setup)
    result.psbt.signAllInputs(setup.keys[0])
    result.psbt.signAllInputs(setup.keys[1])
    result.psbt.finalizeAllInputs()
    const weight = result.psbt.extractTransaction().weight()
    assert.ok(weight <= MAX_STANDARD_TX_WEIGHT,
      `signed transaction weight ${weight} exceeds ${MAX_STANDARD_TX_WEIGHT}`)
  })
})
