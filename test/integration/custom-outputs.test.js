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

  describe('E-4: Custom outputs + P2SH ACTION payload', () => {
    // P2SH/P2WSH is a two-transaction flow. The funding (phase-1) tx creates the
    // P2SH data outputs; the reveal (phase-2) tx spends them and is the tx the
    // indexer reads as the action. customOutputs are therefore EMITTED on the
    // reveal only, with their total FOLDED into the first funding output so the
    // reveal can pay them. Asserting the custom output on the funding tx (which
    // this test used to do) contradicts that contract and only ever passed
    // before the fold existed.
    const CUSTOM_VALUE = 100000

    // Rebuilds the funding tx from the PSBT without a private key: the encoder
    // only reads p2shHex's outputs by index, and the unsigned serialization
    // already yields a stable txid for the reveal's input.
    function unsignedTxFrom (psbt) {
      const tx = new bitcoin.Transaction()
      for (const input of psbt.txInputs) tx.addInput(input.hash, input.index, input.sequence)
      for (const output of psbt.txOutputs) tx.addOutput(output.script, output.value)
      return tx
    }

    async function buildFunding (encoder, address, customOutputs) {
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')
      return await encoder.createTransaction(
        [utxo], address, customOutputs && customOutputs.map(o => ({ ...o })),
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
    }

    it('funding tx carries the P2SH data outputs and folds the custom-output value in', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      const withCustom = await buildFunding(encoder, address, [{ address, value: String(CUSTOM_VALUE) }])
      const withoutCustom = await buildFunding(encoder, address, null)

      assert.strictEqual(withCustom.encoding, 'P2SH')
      assert.strictEqual(withoutCustom.encoding, 'P2SH')

      // Same output SHAPE either way: the custom output is not emitted here.
      assert.strictEqual(withCustom.psbt.txOutputs.length, withoutCustom.psbt.txOutputs.length,
        'funding tx must not gain an output for a reveal-side customOutput')
      assert.ok(!withCustom.psbt.txOutputs.some(o => o.value === CUSTOM_VALUE),
        'the custom output belongs on the reveal, not on the funding tx')

      // The first funding output carries the folded value (plus the reveal's
      // extra miner fee for the bytes that output adds), so the reveal can pay it.
      const fundedDelta = withCustom.psbt.txOutputs[0].value - withoutCustom.psbt.txOutputs[0].value
      assert.ok(fundedDelta >= CUSTOM_VALUE,
        `first funding output should carry >= ${CUSTOM_VALUE} extra, carried ${fundedDelta}`)
    })

    it('reveal tx emits the custom output alongside the ACTION data', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeIssueFull('BIGTOKEN')

      const funding = await buildFunding(encoder, address, [{ address, value: String(CUSTOM_VALUE) }])
      const fundingTx = unsignedTxFrom(funding.psbt)

      const reveal = await encoder.createTransaction(
        [], address, [{ address, value: String(CUSTOM_VALUE) }],
        action.data, null, 10000, false, null, address,
        fundingTx.getId(), fundingTx.toHex(), null, false, 0.00001
      )

      assert.strictEqual(reveal.encoding, 'P2SH')
      // The reveal spends every P2SH data output the funding tx created.
      assert.strictEqual(reveal.psbt.txInputs.length, funding.psbt.txOutputs.length - 1,
        'reveal should spend exactly the funding tx data outputs (all but change)')

      const customOut = reveal.psbt.txOutputs.find(o => o.value === CUSTOM_VALUE)
      assert.ok(customOut, 'custom output should be present on the reveal')
      assert.strictEqual(
        bitcoin.address.fromOutputScript(customOut.script, encoder.network),
        address)

      // Paid exactly once across the pair.
      assert.strictEqual(reveal.psbt.txOutputs.filter(o => o.value === CUSTOM_VALUE).length, 1)
    })
  })

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
