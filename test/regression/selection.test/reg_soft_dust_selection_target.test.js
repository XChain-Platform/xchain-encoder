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
 * Input selection must stop at the fee the build finally charges. On Dogecoin a
 * payment under the soft-dust limit pays dustAmount plus the relay surcharge, so
 * selection that stopped at the rate fee plus surcharge left a fundable spend one
 * input short and refused INSUFFICIENT_FUNDS.
 */

const assert = require('assert')
const {
  TXID_A,
  TXID_B,
  makeUtxo,
  attachPrevTxs,
  makeEncoder,
  getTestAddress
} = require('../../integration/helpers/utxoFactory')

const DOGE = 'dogecoin-regtest'
const PAYMENT = 100000
const DATA = 'SEND|0|X|1|a'

async function build (values) {
  const encoder = makeEncoder(DOGE)
  const address = getTestAddress(DOGE)
  const utxos = values.map((v, i) => makeUtxo(DOGE, i === 0 ? TXID_A : TXID_B, i, v))
  attachPrevTxs(encoder, utxos, DOGE)
  const result = await encoder.createTransaction(
    utxos, address, [{ address, value: PAYMENT }],
    DATA, null, null, false, 'OP_RETURN', address,
    null, null, null, true, 1000
  )
  let paid = 0
  for (const o of result.psbt.txOutputs) paid += Number(o.value)
  const total = values.reduce((a, b) => a + b, 0)
  return { inputs: result.psbt.txInputs.length, fee: total - paid, encoder }
}

describe('DOGE selection target covers the dust floor plus surcharge', () => {
  for (const values of [[1150000, 1000000], [1000000, 1150000]]) {
    it(`funds a sub-soft-dust payment from ${values.join(' + ')}`, async () => {
      const { inputs, fee, encoder } = await build(values)
      assert.strictEqual(inputs, 2)
      assert.ok(fee >= encoder.dustAmount + 1000000, `fee ${fee}`)
    })
  }

  it('stops at an input set that funds the payment and fee exactly', async () => {
    // 600000 + 600000 covers the 100000 payment plus the 1100000 fee with zero change;
    // a third input would leave 600000, under the output floor, as extra fee.
    const { inputs } = await build([600000, 600000, 600000])
    assert.strictEqual(inputs, 2)
  })

  it('still refuses a true shortfall with a single 1150000 input', async () => {
    await assert.rejects(() => build([1150000]), (err) => {
      assert.ok(/insufficient funds/i.test(`${err.code} ${err.reason} ${err.message}`), String(err.message))
      return true
    })
  })
})
