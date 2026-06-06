/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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

const NETWORK = 'dogecoin-regtest'

describe('Custom Output Boundaries', () => {

  // ── parseInt truncation ─────────────────────────────────────────

  describe('parseInt truncation on custom output values', () => {
    it('"1.5" value → output has value=1 (truncated, not rounded)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, [
          { address, value: '1.5' }
        ],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Find the custom output (not OP_RETURN, not the large change)
      const outputs = result.psbt.txOutputs
      const customOutput = outputs.find(o => o.value === 1)
      assert.ok(customOutput, 'custom output should have value=1 (parseInt("1.5")=1)')
    })

    it('"999999.9" → output has value=999999', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, [
          { address, value: '999999.9' }
        ],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const customOutput = result.psbt.txOutputs.find(o => o.value === 999999)
      assert.ok(customOutput, 'custom output should have value=999999')
    })

    it('truncation affects outputSatoshis → change reflects truncated value', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, [
          { address, value: '50000.9' }
        ],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.reduce(
        (max, o) => o.value > max.value ? o : max, { value: 0 }
      )
      // change = 100000000 - 50000 (truncated) - 10000 (fee) = 99940000
      assert.strictEqual(changeOutput.value, 100000000 - 50000 - 10000)
    })
  })

  // ── Many custom outputs ─────────────────────────────────────────

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
        null, null, null, true, 0.001 // moderate fee rate
      )

      const resultWithout = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, 0.001
      )

      const feeWith = 100000000 - 10 - resultWithOutputs.psbt.txOutputs
        .reduce((max, o) => o.value > max.value ? o : max, { value: 0 }).value
      const feeWithout = 100000000 - resultWithout.psbt.txOutputs
        .find(o => o.value > 0).value

      assert.ok(feeWith > feeWithout,
        'more custom outputs should produce higher estimated fee')
    })
  })

  // ── Custom output with value=0 ─────────────────────────────────

  describe('custom output with value=0', () => {
    it('value=0 output is added to PSBT but contributes 0 to outputSatoshis', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, [
          { address, value: 0 }
        ],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Should have: OP_RETURN (value=0), custom output (value=0), change output
      const zeroOutputs = result.psbt.txOutputs.filter(o => o.value === 0)
      assert.ok(zeroOutputs.length >= 2,
        'should have at least 2 zero-value outputs (OP_RETURN + custom)')

      // Change should be unaffected by the 0-value custom output
      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.strictEqual(changeOutput.value, 100000000 - 10000)
    })
  })

  // ── Custom output value > inputs ────────────────────────────────

  describe('custom output value exceeding inputs', () => {
    it('total custom output > UTXO → negative change, no throw', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      // UTXO = 10000, custom output = 50000
      const utxo = makeSegwitUtxo(TXID_A, 0, 10000)

      const result = await encoder.createTransaction(
        [utxo], address, [
          { address, value: 50000 }
        ],
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // changeSatoshis = 10000 - 50000 - 10000 = -50000
      assert.ok(result.psbt instanceof bitcoin.Psbt)
      const changeOutputs = result.psbt.txOutputs.filter(o =>
        o.value > 0 && o.value !== 50000)
      assert.strictEqual(changeOutputs.length, 0,
        'negative change → no change output')
    })
  })

  // ── Empty customOutputs array ───────────────────────────────────

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
