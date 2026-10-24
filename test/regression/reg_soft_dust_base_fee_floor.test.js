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
 * A one-phase Dogecoin build with a payment under the soft-dust limit pays
 * the dust-amount base fee floor PLUS the soft-dust relay surcharge. The floor
 * used to be compared against a fee that already carried the surcharge, so the
 * base collapsed to a few koinu and the P2SH reveal path (which floors first
 * and adds the surcharge after) disagreed with the one-phase path.
 */

const assert = require('assert')
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

async function buildFee (networkKey, paymentValue) {
  const encoder = makeEncoder(networkKey)
  const address = getTestAddress(networkKey)
  const utxo = makeUtxo(networkKey, TXID_A, 0, 100000000)
  const result = await encoder.createTransaction(
    [utxo], address, [{ address, value: paymentValue }],
    DATA, null, null, false, 'OP_RETURN', address,
    null, null, null, true, 1000
  )
  let paid = 0
  for (const o of result.psbt.txOutputs) paid += Number(o.value)
  return { fee: 100000000 - paid, dust: encoder.dustAmount }
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
