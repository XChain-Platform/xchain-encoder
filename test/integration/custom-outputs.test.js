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
 * Category E: Custom Outputs (COINPAY Integration)
 *
 * Verifies that custom outputs (native coin payment outputs for COINPAY)
 * are correctly added to PSBTs alongside ACTION data.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('./helpers/utxoFactory')
const actions = require('./helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

describe('Category E: Custom Outputs (COINPAY Integration)', () => {

  // ── E-1: Custom outputs added to PSBT ─────────────────────────

  describe('E-1: Custom outputs added with correct address and value', () => {
    it('includes both custom outputs in PSBT', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const customOutputs = [
        { address: address, value: '500000' },
        { address: address, value: '300000' }
      ]

      const result = await encoder.createTransaction(
        [utxo], address, customOutputs,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const outputs = result.psbt.txOutputs
      // Should have: OP_RETURN (0) + 2 custom + 1 change = 4 outputs
      assert.strictEqual(outputs.length, 4)

      const customValues = outputs.filter(o =>
        o.value === 500000 || o.value === 300000
      )
      assert.strictEqual(customValues.length, 2)
    })
  })

  // ── E-2: Custom outputs affect fee/change calculation ─────────

  describe('E-2: Custom outputs affect change calculation', () => {
    it('custom output value is deducted from change', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()
      const fee = 10000

      // Without custom outputs
      const resultNoCustom = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, fee, false, null, address,
        null, null, null, true, 0.00001
      )

      // With custom output of 500000 sats
      const customOutputs = [{ address: address, value: '500000' }]
      const resultWithCustom = await encoder.createTransaction(
        [utxo], address, customOutputs,
        action.data, null, fee, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeNoCustom = resultNoCustom.psbt.txOutputs
        .reduce((max, o) => o.value > max ? o.value : max, 0)
      const changeWithCustom = resultWithCustom.psbt.txOutputs
        .reduce((max, o) => o.value > max ? o.value : max, 0)

      assert.strictEqual(changeNoCustom - changeWithCustom, 500000,
        'change should decrease by exactly the custom output value')
    })
  })

  // ── E-3: Non-array customOutputs ignored ──────────────────────

  describe('E-3: Non-array customOutputs ignored', () => {
    it('object instead of array is silently skipped', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, { address: address, value: 1000 },
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Should only have OP_RETURN + change = 2 outputs
      assert.strictEqual(result.psbt.txOutputs.length, 2)
    })

    it('null customOutputs is silently skipped', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txOutputs.length, 2)
    })
  })

  // ── E-4: Custom outputs + large ACTION payload ────────────────

  describe('E-4: Custom outputs + P2SH ACTION payload', () => {
    it('both custom outputs and P2SH data output are present', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      const customOutputs = [
        { address: address, value: '100000' }
      ]

      const result = await encoder.createTransaction(
        [utxo], address, customOutputs,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')

      const outputs = result.psbt.txOutputs
      // Should have: P2SH output + custom output + change = at least 3 outputs
      assert.ok(outputs.length >= 3,
        `expected >= 3 outputs, got ${outputs.length}`)

      // Verify custom output is present
      const customOut = outputs.find(o => o.value === 100000)
      assert.ok(customOut, 'custom output should be present')
    })
  })

  // ── Empty custom outputs array ────────────────────────────────

  describe('Empty customOutputs array', () => {
    it('empty array produces no extra outputs', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, [],
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txOutputs.length, 2)
    })
  })
})
