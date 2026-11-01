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
  ECPair,
  networkOf,
  utxoFor,
  makeEncoder,
  build,
  feeOf
} = require('../../../helpers/psbt_build_fixtures.js')

const BTC = 'bitcoin-regtest'
const FEE_PER_KB = 2000

function privateKey (value) {
  const key = Buffer.alloc(32)
  key.writeUInt32BE(value, 28)
  return ECPair.fromPrivateKey(key)
}

describe('XChainEncoder legacy P2SH multisig funding inputs', function () {
  it('carries redeem metadata into a signed build and pays the requested rate', async function () {
    const network = networkOf(BTC)
    const keys = [privateKey(1), privateKey(2), privateKey(3)]
    const redeem = bitcoin.payments.p2ms({
      m: 2,
      pubkeys: keys.map(key => Buffer.from(key.publicKey)),
      network
    })
    const funding = bitcoin.payments.p2sh({ redeem, network })
    const destination = bitcoin.payments.p2wsh({
      redeem: { output: bitcoin.script.compile([bitcoin.opcodes.OP_TRUE]) },
      network
    })
    const prevTxs = new Map()
    const utxo = utxoFor(prevTxs, funding.output, 1000000, 'legacy-multisig')
    utxo.redeemScript = redeem.output.toString('hex')
    const encoder = makeEncoder(BTC, {
      estimate: FEE_PER_KB / 100000000,
      relayfee: 0.00001,
      prevTxs
    })

    const result = await build(encoder, {
      utxos: [utxo],
      pubkey: funding.address,
      customOutputs: [{ address: destination.address, value: 100000 }],
      change: destination.address,
      feePerKb: FEE_PER_KB
    })
    assert.ok(result.psbt.data.inputs[0].redeemScript.equals(redeem.output))

    const signed = bitcoin.Psbt.fromHex(result.psbt.toHex(), { network })
    signed.signInput(0, keys[0])
    signed.signInput(0, keys[1])
    signed.finalizeAllInputs()
    const vsize = signed.extractTransaction(true).virtualSize()
    const minimumFee = Math.ceil(vsize * FEE_PER_KB / 1000)
    assert.ok(Number(feeOf(result.psbt)) >= minimumFee,
      `fee ${feeOf(result.psbt)} is below ${minimumFee} for ${vsize} vbytes`)
  })
})
