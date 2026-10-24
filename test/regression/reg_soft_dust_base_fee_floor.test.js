/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * A Dogecoin build with a payment under the soft-dust limit pays the dust-amount
 * base fee floor plus the soft-dust relay surcharge. The one-phase path had
 * compared the floor against a fee that already carried the surcharge. Once
 * that floor was corrected, the reveal path counted the carried surcharge a
 * second time. Both paths must keep the same fee and return sweepable surplus.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A,
  makeUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const { floorEstimatedFee } = require('../../src/XChainEncoder/build_transaction/fee_settlement.js')

const DOGE = 'dogecoin-regtest'
const BTC = 'bitcoin-regtest'
const SURCHARGE = 1000000
const DATA = 'SEND|0|X|1|a'
const P2SH_DATA = 'x'.repeat(500)
const INPUT_VALUE = 100000000

async function buildFee (networkKey, paymentValue) {
  const encoder = makeEncoder(networkKey)
  const address = getTestAddress(networkKey)
  const utxo = makeUtxo(networkKey, TXID_A, 0, INPUT_VALUE)
  const result = await encoder.createTransaction(
    [utxo], address, [{ address, value: paymentValue }],
    DATA, null, null, false, 'OP_RETURN', address,
    null, null, null, true, 1000
  )
  let paid = 0
  for (const o of result.psbt.txOutputs) paid += Number(o.value)
  return { fee: INPUT_VALUE - paid, dust: encoder.dustAmount }
}

async function buildP2shRevealFee (paymentValue) {
  const encoder = makeEncoder(DOGE)
  const address = getTestAddress(DOGE)
  const outputs = () => [{ address, value: paymentValue }]
  const funding = await encoder.createTransaction(
    [makeUtxo(DOGE, TXID_A, 0, INPUT_VALUE)], address, outputs(),
    P2SH_DATA, null, null, false, 'P2SH', address,
    null, null, null, true, 1000
  )
  const fundingTx = bitcoin.Transaction.fromBuffer(
    funding.psbt.data.globalMap.unsignedTx.toBuffer()
  )
  const reveal = await encoder.createTransaction(
    [], address, outputs(), P2SH_DATA, null, null, false, 'P2SH', address,
    fundingTx.getId(), fundingTx.toHex(), null, true, 1000
  )
  const revealTx = bitcoin.Transaction.fromBuffer(
    reveal.psbt.data.globalMap.unsignedTx.toBuffer()
  )
  let spent = 0
  for (const input of revealTx.ins) spent += fundingTx.outs[input.index].value
  let paid = 0
  for (const output of revealTx.outs) paid += output.value
  return {
    fee: spent - paid,
    outputFloor: encoder.outputFloor,
    revealTx,
    spent
  }
}

describe('soft-dust build keeps the base fee floor', () => {
  it('unit: floorEstimatedFee lifts a surcharged fee to dustAmount + surcharge', () => {
    const build = { estimatedFee: 1000001, softDustSurcharge: SURCHARGE }
    floorEstimatedFee.call({ dustAmount: 100000 }, build)
    assert.strictEqual(build.estimatedFee, 1100000)
  })

  it('unit: no surcharge keeps the plain dust floor', () => {
    const build = { estimatedFee: 5, softDustSurcharge: 0 }
    floorEstimatedFee.call({ dustAmount: 100000 }, build)
    assert.strictEqual(build.estimatedFee, 100000)
  })

  for (const value of [100000, 999999]) {
    it(`DOGE payment of ${value} pays the floor plus the surcharge`, async () => {
      const { fee, dust } = await buildFee(DOGE, value)
      assert.strictEqual(dust, 100000)
      assert.strictEqual(fee, dust + SURCHARGE)
    })
  }

  it('DOGE payment of 1000000 (no surcharge) pays the floor', async () => {
    const { fee, dust } = await buildFee(DOGE, 1000000)
    assert.strictEqual(fee, dust)
  })

  it('a non-DOGE network is unchanged', async () => {
    const { fee, dust } = await buildFee(BTC, 100000)
    assert.ok(fee >= dust && fee < SURCHARGE, `fee ${fee}`)
  })
})

describe('soft-dust fee parity across one-phase and P2SH reveal builds', () => {
  for (const paymentValue of [100000, 999999, 1000000]) {
    it(`keeps the same fee and returns reveal surplus for payment ${paymentValue}`, async () => {
      const onePhase = await buildFee(DOGE, paymentValue)
      const reveal = await buildP2shRevealFee(paymentValue)
      const expectedFee = onePhase.dust + (paymentValue < SURCHARGE ? SURCHARGE : 0)
      const expectedSweep = reveal.spent - paymentValue - expectedFee

      assert.deepStrictEqual({
        onePhaseFee: onePhase.fee,
        revealFee: reveal.fee,
        feesMatch: reveal.fee === onePhase.fee,
        sweepReturned: reveal.revealTx.outs.some(output => output.value === expectedSweep)
      }, {
        onePhaseFee: expectedFee,
        revealFee: expectedFee,
        feesMatch: true,
        sweepReturned: expectedSweep >= reveal.outputFloor
      })
    })
  }
})
