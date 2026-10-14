// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Dogecoin relays an output under its 0.01 DOGE soft dust limit only when the whole
// limit is added to the fee, once per such output. A payment between the hard limit
// (100000 koinu) and the soft limit (1000000) is allowed, so the fee carries that
// surcharge; a payment at the soft limit carries none.

const assert = require('assert')
const { paymentFor, utxoFor, makeEncoder, build, unsignedTx, feeOf } = require('../../../helpers/psbt_build_fixtures.js')

const DOGE = 'dogecoin-regtest'
const SOFT_DUST = 1000000n
const RELAY_PER_KB = 100000 // 0.001 DOGE/kB, the node estimate as well

function dogeEncoder (prevTxs) {
  return makeEncoder(DOGE, { estimate: 0.001, relayfee: 0.001, prevTxs })
}

// Relay minimum on the signed size: each P2PKH input gains a ~107-byte scriptSig.
function relayMinimum (res) {
  const size = unsignedTx(res).byteLength() + 107 * res.psbt.txInputs.length
  return BigInt(Math.ceil(size * RELAY_PER_KB / 1000))
}

async function payment (value, extra = {}) {
  const prevTxs = new Map()
  const pay = paymentFor('p2pkh', DOGE)
  return build(dogeEncoder(prevTxs), Object.assign({
    utxos: [utxoFor(prevTxs, pay.output, 500000000, 'doge-pay' + value + JSON.stringify(extra))], pubkey: pay.address,
    customOutputs: [{ address: pay.address, value }], change: pay.address
  }, extra))
}

describe('XChainEncoder Dogecoin soft-dust relay surcharge', function () {
  for (const value of [100000, 500000, 999999]) {
    it(`adds the whole soft limit to the fee for a ${value}-koinu payment`, async function () {
      const res = await payment(value)
      assert.ok(feeOf(res.psbt) >= relayMinimum(res) + SOFT_DUST,
        `fee ${feeOf(res.psbt)} lacks the ${SOFT_DUST} surcharge over ${relayMinimum(res)}`)
    })
  }

  it('adds nothing for a payment at the soft limit', async function () {
    const res = await payment(1000000)
    assert.ok(feeOf(res.psbt) < SOFT_DUST, `fee ${feeOf(res.psbt)} carries a surcharge it does not owe`)
  })

  it('surcharges a hub feeQuote output under the soft limit', async function () {
    const prevTxs = new Map()
    const pay = paymentFor('p2pkh', DOGE)
    const res = await build(dogeEncoder(prevTxs), {
      utxos: [utxoFor(prevTxs, pay.output, 500000000, 'doge-quote')], pubkey: pay.address, data: 'BROADCAST|0|hi',
      encoding: 'OP_RETURN', change: pay.address, feeQuote: { address: pay.address, amount: 300000 }
    })
    assert.ok(feeOf(res.psbt) >= relayMinimum(res) + SOFT_DUST)
  })

  it('adds the surcharge on top of an explicit fee', async function () {
    const res = await payment(500000, { fee: 200000 })
    assert.strictEqual(feeOf(res.psbt), 200000n + SOFT_DUST)
  })

  it('prefunds the surcharge for a sub-limit payment on a P2SH reveal', async function () {
    const prevTxs = new Map()
    const pay = paymentFor('p2pkh', DOGE)
    const encoder = dogeEncoder(prevTxs)
    const common = { pubkey: pay.address, data: 'x'.repeat(600), encoding: 'P2SH', change: pay.address,
      customOutputs: [{ address: pay.address, value: 500000 }] }
    const funding = await build(encoder, Object.assign({ utxos: [utxoFor(prevTxs, pay.output, 500000000, 'doge-p2sh')] }, common))
    const fundingTx = unsignedTx(funding)
    const reveal = await build(encoder, Object.assign({ utxos: [], p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex() }, common))
    // A P2SH reveal input carries its whole redeem script plus a signature and key.
    const signedSize = unsignedTx(reveal).byteLength() +
      reveal.psbt.data.inputs.reduce((n, input) => n + input.redeemScript.length + 110, 0)
    const fee = feeOf(reveal.psbt)
    assert.ok(fee >= BigInt(Math.ceil(signedSize * RELAY_PER_KB / 1000)) + SOFT_DUST,
      `reveal fee ${fee} lacks the surcharge for its 500000-koinu payment`)
  })
})
