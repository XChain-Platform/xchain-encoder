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

const FLOORS = { btc: 546, ltc: 5460, doge: 100000 }

function pay (coin, value, extra = {}) {
  const kind = coin === 'doge' ? 'p2pkh' : 'p2wpkh'
  return F.create(F.makeEncoder(coin), {
    utxos: [F.makeUtxo(coin, kind, coin === 'doge' ? 500000000 : 5000000)], pubkey: F.p2pkhAddr(coin),
    data: 'BROADCAST|0|0|x', encoding: extra.encoding || 'OP_RETURN', change: F.p2pkhAddr(coin),
    customOutputs: [{ address: F.otherAddr(coin), value }], feeQuote: extra.feeQuote
  })
}

function registerPaymentOutputTests () {
  for (const coin of Object.keys(FLOORS)) {
    it(`${coin}: the encoder exposes ${FLOORS[coin]} as its payment floor`, () => {
      assert.strictEqual(F.makeEncoder(coin).paymentOutputFloor, FLOORS[coin])
    })
    it(`${coin}: one unit under the floor is refused`, async () => {
      await assert.rejects(pay(coin, FLOORS[coin] - 1), (err) => err instanceof RangeError && /dust/.test(err.message))
    })
    it(`${coin}: exactly the floor builds`, async () => {
      const res = await pay(coin, FLOORS[coin])
      assert.ok(res.psbt.txOutputs.some((o) => Number(o.value) === FLOORS[coin]))
    })
  }

  it('doge: a 0.005 DOGE payment between the hard and soft limits builds', async () => {
    const res = await pay('doge', 500000)
    assert.ok(res.psbt.txOutputs.some((o) => Number(o.value) === 500000))
  })

  it('a P2WSH funding call refuses a sub-dust payment before the commit is built', async () => {
    await assert.rejects(pay('btc', 545, { encoding: 'P2WSH' }), /dust/)
  })
}

function registerProtocolFeeTests () {
  it('the protocol-fee output injected from feeQuote keeps its own positive-amount rule', async () => {
    await assert.rejects(pay('btc', 546, { feeQuote: { address: F.otherAddr('btc'), amount: 300 } }),
      (err) => err instanceof RangeError && /feeQuote\.amount/.test(err.message) && /dust/.test(err.message))
  })

  for (const coin of Object.keys(FLOORS)) {
    it(`${coin}: a protocol fee exactly at the floor builds`, async () => {
      const res = await pay(coin, FLOORS[coin], { feeQuote: { address: F.otherAddr(coin), amount: FLOORS[coin] } })
      assert.strictEqual(res.psbt.txOutputs.filter((o) => Number(o.value) === FLOORS[coin]).length, 2)
    })
  }

  it('a P2WSH funding call refuses a sub-dust protocol fee before the commit is built', async () => {
    await assert.rejects(pay('btc', 546, { encoding: 'P2WSH', feeQuote: { address: F.otherAddr('btc'), amount: 545 } }),
      /feeQuote\.amount.*dust/)
  })
}

function registerJsonRpcTests () {
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

  it('create_tx answers a sub-dust protocol fee with -32602 before any node call', async () => {
    const encoder = F.makeEncoder('btc')
    const calls = []
    const info = encoder.connector.getNetworkInfo
    encoder.connector.getNetworkInfo = (...args) => { calls.push('networkinfo'); return info(...args) }
    const controller = createJsonRpcController({ encoder, NETWORK: 'bitcoin-regtest' })
    const params = { pubkey: F.p2pkhAddr('btc'), data: 'BROADCAST|0|0|x', change: F.p2pkhAddr('btc'),
      customOutputs: [{ address: F.otherAddr('btc'), value: 546 }], feeQuote: { address: F.otherAddr('btc'), amount: 545 } }
    await assert.rejects(controller.create_tx(params),
      (err) => err.code === -32602 && /feeQuote\.amount/.test(err.message) && /dust/.test(err.message))
    assert.deepStrictEqual(calls, [])
  })
}

function registerValidationTests () {
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
    it('applies the floor to feeQuote only when the caller passes one', () => {
      assert.throws(() => validator.validateAll({ ...base, feeQuote: { address: 'a', amount: 545 } }, { paymentOutputFloor: 546 }),
        (err) => err instanceof RangeError && /feeQuote\.amount 545 is below the 546/.test(err.message))
      assert.strictEqual(validator.validateAll({ ...base, feeQuote: { address: 'a', amount: 1 } }).feeQuote.amount, 1)
    })
  })
}

describe('caller payment outputs respect the coin relay dust threshold', () => {
  registerPaymentOutputTests()
  registerProtocolFeeTests()
  registerJsonRpcTests()
  registerValidationTests()
})
