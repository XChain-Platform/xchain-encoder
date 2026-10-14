// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A caller payment output under the coin's hard relay dust threshold makes the
// transaction unrelayable, so it is refused before anything is built. Dogecoin's 0.01
// DOGE soft limit is not a refusal floor: wallet native-fee outputs are padded only to
// the hard threshold, so a payment between the two still builds.

'use strict'

const assert = require('assert')
const F = require('./helpers/build_fixture')
const validator = require('../../../../src/common/validator')
const { createJsonRpcController } = require('../../../../src/api/json_rpc_methods')

function pay (coin, value, extra = {}) {
  const kind = coin === 'doge' ? 'p2pkh' : 'p2wpkh'
  return F.create(F.makeEncoder(coin), {
    utxos: [F.makeUtxo(coin, kind, coin === 'doge' ? 500000000 : 5000000)], pubkey: F.p2pkhAddr(coin),
    data: 'BROADCAST|0|0|x', encoding: extra.encoding || 'OP_RETURN', change: F.p2pkhAddr(coin),
    customOutputs: [{ address: F.otherAddr(coin), value }], feeQuote: extra.feeQuote
  })
}

describe('caller payment outputs respect the coin relay dust threshold', () => {
  const floors = { btc: 546, ltc: 5460, doge: 100000 }

  for (const coin of Object.keys(floors)) {
    it(`${coin}: the encoder exposes ${floors[coin]} as its payment floor`, () => {
      assert.strictEqual(F.makeEncoder(coin).paymentOutputFloor, floors[coin])
    })
    it(`${coin}: one unit under the floor is refused`, async () => {
      await assert.rejects(pay(coin, floors[coin] - 1), (err) => err instanceof RangeError && /dust/.test(err.message))
    })
    it(`${coin}: exactly the floor builds`, async () => {
      const res = await pay(coin, floors[coin])
      assert.ok(res.psbt.txOutputs.some((o) => Number(o.value) === floors[coin]))
    })
  }

  it('doge: a 0.005 DOGE payment between the hard and soft limits builds', async () => {
    const res = await pay('doge', 500000)
    assert.ok(res.psbt.txOutputs.some((o) => Number(o.value) === 500000))
  })

  it('a P2WSH funding call refuses a sub-dust payment before the commit is built', async () => {
    await assert.rejects(pay('btc', 545, { encoding: 'P2WSH' }), /dust/)
  })

  it('the protocol-fee output injected from feeQuote keeps its own positive-amount rule', async () => {
    const res = await pay('btc', 546, { feeQuote: { address: F.otherAddr('btc'), amount: 300 } })
    assert.ok(res.psbt.txOutputs.some((o) => Number(o.value) === 300))
  })

  it('create_tx answers a sub-dust payment with -32602 before any node call', async () => {
    const encoder = F.makeEncoder('btc')
    const calls = []
    const info = encoder.connector.getNetworkInfo
    encoder.connector.getNetworkInfo = (...args) => { calls.push('networkinfo'); return info(...args) }
    const controller = createJsonRpcController({ encoder, NETWORK: 'bitcoin-regtest' })
    const params = { pubkey: F.p2pkhAddr('btc'), data: 'BROADCAST|0|0|x', change: F.p2pkhAddr('btc'),
      customOutputs: [{ address: F.otherAddr('btc'), value: 545 }] }
    await assert.rejects(controller.create_tx(params), (err) => err.code === -32602 && /dust/.test(err.message))
    assert.deepStrictEqual(calls, [])
  })

  describe('validateAll at the API boundary', () => {
    const base = { pubkey: 'addr', data: 'BROADCAST|0|0|x' }
    it('refuses an output under the floor the caller passes', () => {
      assert.throws(() => validator.validateAll({ ...base, customOutputs: [{ address: 'a', value: 545 }] }, { paymentOutputFloor: 546 }),
        (err) => err instanceof RangeError && /customOutputs\[0\]\.value 545 is below the 546/.test(err.message))
    })
    it('accepts an output at the floor', () => {
      const r = validator.validateAll({ ...base, customOutputs: [{ address: 'a', value: 546 }] }, { paymentOutputFloor: 546 })
      assert.strictEqual(r.customOutputs[0].value, 546)
    })
    it('keeps the positive-amount rule when no floor is passed', () => {
      assert.strictEqual(validator.validateAll({ ...base, customOutputs: [{ address: 'a', value: 1 }] }).customOutputs[0].value, 1)
    })
  })
})
