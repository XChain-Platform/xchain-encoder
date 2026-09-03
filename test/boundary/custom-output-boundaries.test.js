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
 * Custom Output Boundary Tests
 *
 * Tests edge cases in the customOutputs parameter: parseInt truncation
 * on fractional string values, many outputs driving UTXO selection,
 * value=0 outputs, and total value exceeding UTXO inputs.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A,
  TXID_B,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')

// BTC semantics: the change/fee assertions assume the supplied fee (10000) is
// honored. DOGE floors sub-100000 fees (covered in the fee-cap tests).
const NETWORK = 'bitcoin-regtest'

describe('Custom Output Boundaries', () => {

  // Previously parseInt silently truncated a decimal amount ("1.5" -> 1),
  // paying a different amount than the caller specified and skewing the change
  // math. The exact-integer parse now rejects any non-integer money value.

  describe('non-integer custom output values are rejected', () => {
    const REJECT = /must be a non-negative integer/

    it('"1.5" value is rejected, not truncated to 1', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(() => encoder.createTransaction(
        [utxo], address, [
          { address, value: '1.5' }
        ],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      ), REJECT)
    })

    it('"999999.9" is rejected, not truncated to 999999', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(() => encoder.createTransaction(
        [utxo], address, [
          { address, value: '999999.9' }
        ],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      ), REJECT)
    })

    it('a clean integer custom output value still builds correctly', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, [
          { address, value: '50000' }
        ],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.reduce(
        (max, o) => o.value > max.value ? o : max, { value: 0 }
      )
      // change = 100000000 - 50000 - 10000 (fee)
      assert.strictEqual(changeOutput.value, 100000000 - 50000 - 10000)
    })
  })

  describe('many custom outputs', () => {
    it('10 custom outputs each worth 100000 → correct total in outputSatoshis', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const customOutputs = Array.from({ length: 10 }, () => ({
        address,
        value: 100000
      }))

      const result = await encoder.createTransaction(
        [utxo], address, customOutputs,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Total custom outputs = 10 * 100000 = 1000000
      // change = 100000000 - 1000000 - 10000 = 98990000
      const changeOutput = result.psbt.txOutputs.reduce(
        (max, o) => o.value > max.value ? o : max, { value: 0 }
      )
      assert.strictEqual(changeOutput.value, 98990000)
    })

    it('each custom output adds 43 bytes to estimated tx size', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // With 10 custom outputs (each adding 43 bytes), the total estimated
      // size is 430 bytes larger. With auto fee, the fee should be measurably higher.
      const resultWithOutputs = await encoder.createTransaction(
        [utxo], address,
        Array.from({ length: 10 }, () => ({ address, value: 1 })),
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, 100000 // sat/kB: 100 sat/byte, moderate fee rate
      )

      // Same input on purpose: release the first build's reservation.
      encoder.clearReservations()
      const resultWithout = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, 100000
      )

      const feeWith = 100000000 - 10 - resultWithOutputs.psbt.txOutputs
        .reduce((max, o) => o.value > max.value ? o : max, { value: 0 }).value
      const feeWithout = 100000000 - resultWithout.psbt.txOutputs
        .find(o => o.value > 0).value

      assert.ok(feeWith > feeWithout,
        'more custom outputs should produce higher estimated fee')
    })
  })

  describe('custom output with value=0', () => {
    // Contract change (input-validation finding): a 0-sat caller output is
    // consensus-valid but relay-rejected as dust, so building it hands the caller
    // an unbroadcastable PSBT. The encoder now rejects value <= 0 on non-fee
    // custom outputs (interim safe rule: bare positivity, not a per-network dust
    // floor). The native-fee FEE_DESTINATION output is injected post-validation
    // and is always positive, so it is unaffected.
    it('value=0 output is rejected as a non-positive custom output', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, [
            { address, value: 0 }
          ],
          'SEND|0|X|1|a', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        { name: 'RangeError', message: /customOutputs\[0\].value must be a positive integer/ }
      )
    })
  })

  describe('custom output value exceeding inputs', () => {
    // M-8: custom outputs (50000) + fee (10000) exceed the 10000-sat input, so
    // the encoder throws INSUFFICIENT_FUNDS rather than return an unbroadcastable
    // PSBT whose outputs exceed its inputs (the pre-M-8 behavior returned it).
    it('total custom output > UTXO throws INSUFFICIENT_FUNDS', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      // UTXO = 10000, custom output = 50000
      const utxo = makeSegwitUtxo(TXID_A, 0, 10000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, [
            { address, value: 50000 }
          ],
          'SEND|0|X|1|a', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'INSUFFICIENT_FUNDS' &&
                 err.details.outputs === 50000 &&
                 err.details.available === 10000
      )
    })
  })

  describe('empty customOutputs array', () => {
    it('empty array has no effect on outputs or fees', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const resultEmpty = await encoder.createTransaction(
        [utxo], address, [],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Same input on purpose: release the first build's reservation.
      encoder.clearReservations()
      const resultNull = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeEmpty = resultEmpty.psbt.txOutputs.find(o => o.value > 0).value
      const changeNull = resultNull.psbt.txOutputs.find(o => o.value > 0).value
      assert.strictEqual(changeEmpty, changeNull,
        'empty array should behave identically to null')
    })
  })
})
