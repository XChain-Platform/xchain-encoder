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
 * REG-03: Fee & UTXO Selection
 *
 * Regression sentinel for UTXO selection order, fee calculation, dust
 * floor enforcement, change output logic, deduplication, unconfirmed
 * filtering, and tracker fallback. These are the most financially
 * consequential code paths in the encoder.
 */

const assert = require('assert')
const {
  TXID_A,
  TXID_B,
  TXID_C,
  makeSegwitUtxo,
  makeLegacyUtxo,
  makeMempoolUtxo,
  makeEncoder,
  getTestAddress,
  buildRawTxHex
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

describe('REG-03: Fee & UTXO Selection', function () {

  // ── REG-03.1: UTXO selection order ────────────────────────────

  describe('REG-03.1: UTXO selection order', function () {
    it('largest UTXO is used first (sorted descending by value)', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const utxoSmall = makeSegwitUtxo(TXID_A, 0, 10000)
      const utxoLarge = makeSegwitUtxo(TXID_B, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxoSmall, utxoLarge], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // First input should be the larger UTXO (TXID_B)
      const firstInputHash = result.psbt.txInputs[0].hash.reverse().toString('hex')
      assert.strictEqual(firstInputHash, TXID_B)
    })

    it('single large UTXO avoids pulling in additional UTXOs', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const utxoLarge = makeSegwitUtxo(TXID_A, 0, 100000000)
      const utxoSmall = makeSegwitUtxo(TXID_B, 0, 1000)

      const result = await encoder.createTransaction(
        [utxoLarge, utxoSmall], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Only 1 input needed since large UTXO covers everything
      assert.strictEqual(result.psbt.txInputs.length, 1)
    })

    it('adds UTXOs until inputs cover outputs + fee', async function () {
      const encoder = makeEncoder(NETWORK)
      // The oversized explicit fee forces multi-UTXO selection; it would trip
      // the relative fee-rate cap (tested in XChainEncoder.feeRateCap.test.js).
      encoder.maxFeeRateMultiplier = null
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      // Three UTXOs, none individually sufficient for fee=150000
      const utxo1 = makeSegwitUtxo(TXID_A, 0, 100000)
      const utxo2 = makeSegwitUtxo(TXID_B, 0, 100000)
      const utxo3 = makeSegwitUtxo(TXID_C, 0, 100000)

      const result = await encoder.createTransaction(
        [utxo1, utxo2, utxo3], address, null,
        action.data, null, 150000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt.txInputs.length >= 2, 'should use multiple UTXOs')
    })
  })

  // ── REG-03.2: Deduplication ───────────────────────────────────

  describe('REG-03.2: Deduplication', function () {
    it('duplicate txid+vout entries collapsed to one input', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const utxo1 = makeSegwitUtxo(TXID_A, 0, 100000000)
      const utxo2 = makeSegwitUtxo(TXID_A, 0, 100000000) // duplicate

      const result = await encoder.createTransaction(
        [utxo1, utxo2], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txInputs.length, 1)
    })
  })

  // ── REG-03.3: Unconfirmed filtering ───────────────────────────

  describe('REG-03.3: Unconfirmed filtering', function () {
    it('mempool UTXOs excluded when unconfirmed=false', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const confirmedUtxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const mempoolUtxo = makeMempoolUtxo(TXID_B, 0, 200000000)

      const result = await encoder.createTransaction(
        [confirmedUtxo, mempoolUtxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, false, 0.00001
      )

      // Only the confirmed UTXO should be used
      assert.strictEqual(result.psbt.txInputs.length, 1)
      const inputHash = result.psbt.txInputs[0].hash.reverse().toString('hex')
      assert.strictEqual(inputHash, TXID_A)
    })

    it('mempool UTXOs included when unconfirmed=true', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const smallConfirmed = makeSegwitUtxo(TXID_A, 0, 1000)
      const largeMem = makeMempoolUtxo(TXID_B, 0, 100000000)

      const result = await encoder.createTransaction(
        [smallConfirmed, largeMem], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Largest UTXO (mempool) should be first input
      const firstHash = result.psbt.txInputs[0].hash.reverse().toString('hex')
      assert.strictEqual(firstHash, TXID_B)
    })
  })

  // ── REG-03.4: Fee calculation ─────────────────────────────────

  describe('REG-03.4: Fee calculation', function () {
    it('explicit fee parameter is used verbatim', async function () {
      const encoder = makeEncoder(NETWORK)
      // This fee sits above the relative fee-rate cap by design; the cap has
      // its own suite (XChainEncoder.feeRateCap.test.js), disable it here.
      encoder.maxFeeRateMultiplier = null
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 50000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Change = input - outputs - fee. With explicit fee=50000:
      const outputs = result.psbt.txOutputs
      const totalOutput = outputs.reduce((sum, o) => sum + o.value, 0)
      const impliedFee = 100000000 - totalOutput
      assert.strictEqual(impliedFee, 50000)
    })

    it('feePerKb parameter bypasses RPC getFeePerKilobyte call', async function () {
      const encoder = makeEncoder(NETWORK)
      // Override connector to throw if called
      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('getFeePerKilobyte should not be called')
      }
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      // Should NOT throw because feePerKb is provided
      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt, 'should produce a PSBT without calling getFeePerKilobyte')
    })

    it('fee is floored to network dustAmount', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      // Very low feePerKb that would produce fee below dust
      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.0000001
      )

      const outputs = result.psbt.txOutputs
      const totalOutput = outputs.reduce((sum, o) => sum + o.value, 0)
      const impliedFee = 100000000 - totalOutput
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= dust ${encoder.dustAmount}`)
    })

    it('maxFeeRateKb cap produces lower fee than uncapped encoder', async function () {
      const XChainEncoder = require('../../src/XChainEncoder')
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      // Uncapped encoder with high feePerKb
      const uncapped = makeEncoder(NETWORK)
      const resultUncapped = await uncapped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 1.0 // 1 BTC/kB — very high
      )

      // Capped encoder (maxFeeRateKb = 1000 sat/kB)
      const capped = new XChainEncoder(
        NETWORK, '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 1000
      )
      const rawTxHex = buildRawTxHex(100000000, NETWORK)
      capped.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => rawTxHex
      }

      const resultCapped = await capped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 1.0 // same high rate, but capped
      )

      const uncappedOut = resultUncapped.psbt.txOutputs.reduce((s, o) => s + o.value, 0)
      const cappedOut = resultCapped.psbt.txOutputs.reduce((s, o) => s + o.value, 0)
      // Capped should return more change (lower fee)
      assert.ok(cappedOut > uncappedOut,
        `capped output ${cappedOut} should be > uncapped ${uncappedOut}`)
    })
  })

  // ── REG-03.5: Change output ───────────────────────────────────

  describe('REG-03.5: Change output', function () {
    it('change output value = input - outputs - fee', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()
      const explicitFee = 10000

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, explicitFee, false, null, address,
        null, null, null, true, 0.00001
      )

      const outputs = result.psbt.txOutputs
      const totalOutput = outputs.reduce((sum, o) => sum + o.value, 0)
      assert.strictEqual(100000000 - totalOutput, explicitFee)
    })

    it('no change address throws when changeSatoshis > dust', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, null, // no change address
          null, null, null, true, 0.00001
        ),
        { message: /change address/ }
      )
    })
  })

  // ── REG-03.6: UTXO tracker fallback ───────────────────────────

  describe('REG-03.6: UTXO tracker fallback', function () {
    it('calls tracker when utxos param is null', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()
      let trackerCalled = false

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        return { utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)] }
      }

      await encoder.createTransaction(
        null, address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(trackerCalled, 'utxoTracker should have been called')
    })

    it('throws when tracker returns empty list', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        return { utxos: [] }
      }

      await assert.rejects(
        () => encoder.createTransaction(
          null, address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        { message: /no utxos/ }
      )
    })
  })

  // ── REG-03.7: Legacy UTXO handling ────────────────────────────

  describe('REG-03.7: Legacy UTXO handling', function () {
    it('fetches raw tx hex via connector for P2PKH UTXOs', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()
      let getHexCalled = false

      encoder.connector.getTransactionHex = async () => {
        getHexCalled = true
        return buildRawTxHex(100000000, NETWORK)
      }

      const utxo = makeLegacyUtxo(TXID_A, 0, 100000000)

      await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(getHexCalled, 'getTransactionHex should be called for legacy UTXOs')
    })

    it('segwit UTXOs do NOT call getTransactionHex', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      encoder.connector.getTransactionHex = async () => {
        throw new Error('getTransactionHex should not be called for segwit')
      }

      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Should NOT throw
      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt, 'should produce PSBT without calling getTransactionHex')
    })
  })
})
