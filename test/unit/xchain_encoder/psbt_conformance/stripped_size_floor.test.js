// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A single-transaction build whose change folds into the fee can serialize under the
// node's MIN_STANDARD_TX_NONWITNESS_SIZE (Litecoin Core 82, Bitcoin Core 65), and the
// node will not relay it. Selection then takes another input to lift it over the
// floor, and a build with no input left to do that is refused instead of returned.

const assert = require('assert')
const { paymentFor, utxoFor, makeEncoder, build, unsignedTx, feeOf } = require('../../../helpers/psbt_build_fixtures.js')

const FEE_PER_KB = 2000
const LTC = 'litecoin-regtest'

function encoderFor (network, prevTxs) {
  return makeEncoder(network, { estimate: 0.00002, relayfee: 0.00001, prevTxs })
}

// The fee an OP_RETURN action costs from one large p2wpkh input on `network`.
async function opReturnFee (network, data) {
  const prevTxs = new Map()
  const pay = paymentFor('p2wpkh', network)
  const res = await build(encoderFor(network, prevTxs), {
    utxos: [utxoFor(prevTxs, pay.output, 1000000, 'probe' + network + data)], pubkey: pay.address,
    data, encoding: 'OP_RETURN', change: pay.address, feePerKb: FEE_PER_KB
  })
  return Number(feeOf(res.psbt))
}

async function opReturnBuild (network, data, values) {
  const prevTxs = new Map()
  const pay = paymentFor('p2wpkh', network)
  const utxos = values.map((v, i) => utxoFor(prevTxs, pay.output, v, network + data + i + ':' + v))
  return build(encoderFor(network, prevTxs), {
    utxos, pubkey: pay.address, data, encoding: 'OP_RETURN', change: pay.address, feePerKb: FEE_PER_KB
  })
}

// A one-input p2wpkh payment to one p2wpkh output whose change folds: 82 stripped bytes.
async function sweepBuild (network) {
  const prevTxs = new Map()
  const pay = paymentFor('p2wpkh', network)
  const value = 1000000
  const probe = await build(encoderFor(network, prevTxs), {
    utxos: [utxoFor(prevTxs, pay.output, value, 'sweep-probe' + network)], pubkey: pay.address,
    customOutputs: [{ address: pay.address, value: 500000 }], change: pay.address, feePerKb: FEE_PER_KB
  })
  const sweepValue = value - Number(feeOf(probe.psbt)) - 10
  return build(encoderFor(network, prevTxs), {
    utxos: [utxoFor(prevTxs, pay.output, value, 'sweep' + network)], pubkey: pay.address,
    customOutputs: [{ address: pay.address, value: sweepValue }], change: pay.address, feePerKb: FEE_PER_KB
  })
}

describe('XChainEncoder stripped-size floor on single-transaction builds', function () {
  for (const data of ['BROADCAST|0|hi', 'ADDRESS|0|1|0']) {
    it(`litecoin-regtest ${data}: refuses an OP_RETURN-only build its one input cannot lift over 82 bytes`, async function () {
      const fee = await opReturnFee(LTC, data)
      await assert.rejects(opReturnBuild(LTC, data, [fee + 100]),
        (e) => e.xchainCode === 'TX_BELOW_MIN_STANDARD_SIZE' && e.details.minimum === 82 && e.details.strippedSize < 82)
    })

    it(`litecoin-regtest ${data}: takes a second input to lift an OP_RETURN-only build over 82 bytes`, async function () {
      const fee = await opReturnFee(LTC, data)
      const res = await opReturnBuild(LTC, data, [fee + 100, fee + 50])
      const stripped = unsignedTx(res).byteLength(false)
      assert.strictEqual(res.psbt.txInputs.length, 2)
      assert.ok(stripped >= 82, `stripped size ${stripped} is under 82`)
    })
  }

  it('bitcoin-regtest: builds a one-input OP_RETURN-only transaction, which clears 65 bytes', async function () {
    const fee = await opReturnFee('bitcoin-regtest', 'BROADCAST|0|hi')
    const res = await opReturnBuild('bitcoin-regtest', 'BROADCAST|0|hi', [fee + 100])
    assert.strictEqual(res.psbt.txInputs.length, 1)
    assert.ok(unsignedTx(res).byteLength(false) >= 65)
  })

  it('litecoin-regtest: builds a full sweep to one p2wpkh payment, 82 bytes at the 82-byte floor', async function () {
    const res = await sweepBuild(LTC)
    assert.strictEqual(res.psbt.txOutputs.length, 1)
    assert.strictEqual(unsignedTx(res).byteLength(false), 82)
  })

  it('leaves a build that returns change untouched by the floor', async function () {
    const res = await opReturnBuild(LTC, 'BROADCAST|0|hi', [1000000])
    assert.strictEqual(res.psbt.txInputs.length, 1)
    assert.strictEqual(res.psbt.txOutputs.length, 2)
  })
})
