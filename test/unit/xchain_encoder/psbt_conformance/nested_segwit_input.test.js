// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Treat P2SH-P2WPKH as a segwit spend with witnessUtxo and its P2WPKH redeemScript.
// It costs about 91 vbytes, versus 299 for worst-case legacy 2-of-3 multisig.
// Derive the redeem script from the request key; without one the input stays legacy.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { ECPair, PRIVATE_KEY, PUBKEY, PUBKEY_HEX, networkOf, paymentFor, utxoFor, makeEncoder, build, feeOf } =
  require('../../../helpers/psbt_build_fixtures.js')

const BTC = 'bitcoin-regtest'
const FEE_PER_KB = 2000

async function nestedBuild (request) {
  const prevTxs = new Map()
  const nested = paymentFor('p2sh-p2wpkh', BTC)
  const encoder = makeEncoder(BTC, { estimate: 0.00002, relayfee: 0.00001, prevTxs })
  const res = await build(encoder, Object.assign({
    utxos: [utxoFor(prevTxs, nested.output, 1000000, 'nested'), utxoFor(prevTxs, nested.output, 300000, 'nested2')],
    data: 'BROADCAST|0|hi', encoding: 'OP_RETURN', change: nested.address, feePerKb: FEE_PER_KB,
    customOutputs: [{ address: paymentFor('p2wpkh', BTC).address, value: 1100000 }]
  }, request))
  return { res, nested }
}

describe('XChainEncoder P2SH-P2WPKH funding inputs', function () {
  it('builds each input with witnessUtxo and the key\'s P2WPKH redeemScript', async function () {
    const { res, nested } = await nestedBuild({ pubkey: PUBKEY_HEX })
    for (const input of res.psbt.data.inputs) {
      assert.ok(input.witnessUtxo, 'witnessUtxo carries the value a segwit sighash commits to')
      assert.ok(input.redeemScript && input.redeemScript.equals(nested.redeem.output))
    }
  })

  it('prices the inputs at their signed size, so the fee lands at the requested rate', async function () {
    const { res } = await nestedBuild({ pubkey: PUBKEY_HEX })
    const psbt = bitcoin.Psbt.fromHex(res.psbt.toHex(), { network: networkOf(BTC) })
    psbt.signAllInputs(ECPair.fromPrivateKey(PRIVATE_KEY))
    psbt.finalizeAllInputs()
    const vsize = psbt.extractTransaction(true).virtualSize()
    const rate = Number(feeOf(res.psbt)) / vsize
    assert.ok(rate >= FEE_PER_KB / 1000 && rate < 1.25 * FEE_PER_KB / 1000, `fee rate ${rate} per vbyte`)
  })

  it('takes the key from compressedPubKey when pubkey is the P2SH address', async function () {
    const nested = paymentFor('p2sh-p2wpkh', BTC)
    const { res } = await nestedBuild({ pubkey: nested.address, compressedPubKey: PUBKEY_HEX })
    assert.ok(res.psbt.data.inputs.every(input => input.redeemScript && input.witnessUtxo))
  })

  it('builds a P2SH address given with no public key as a legacy input', async function () {
    const nested = paymentFor('p2sh-p2wpkh', BTC)
    const { res } = await nestedBuild({ pubkey: nested.address })
    assert.ok(res.psbt.data.inputs.every(input => input.nonWitnessUtxo && !input.witnessUtxo && !input.redeemScript))
  })

  it('leaves a P2SH input the key does not match as a legacy input', async function () {
    const prevTxs = new Map()
    const net = networkOf(BTC)
    const other = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2ms({ m: 1, pubkeys: [PUBKEY], network: net }), network: net })
    const pay = paymentFor('p2wpkh', BTC)
    const res = await build(makeEncoder(BTC, { estimate: 0.00002, relayfee: 0.00001, prevTxs }), {
      utxos: [utxoFor(prevTxs, other.output, 1000000, 'legacy-p2sh')], pubkey: PUBKEY_HEX,
      data: 'BROADCAST|0|hi', encoding: 'OP_RETURN', change: pay.address, feePerKb: FEE_PER_KB
    })
    const input = res.psbt.data.inputs[0]
    assert.ok(input.nonWitnessUtxo && !input.witnessUtxo && !input.redeemScript)
  })
})
