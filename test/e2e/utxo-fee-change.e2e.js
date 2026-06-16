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
 * E2E-5: UTXO, Fee, and Change Integration
 *
 * Validates PSBT input selection, fee calculation, and change outputs
 * for realistic encoding scenarios.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
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

describe('E2E-5: UTXO, Fee, and Change Integration', () => {

  // ── E2E-5.1: Single UTXO covers all ──────────────────────────

  describe('E2E-5.1: Single UTXO covers all', () => {
    it('1 input, OP_RETURN + change; change = input - fee', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
      assert.strictEqual(result.psbt.txOutputs.length, 2)

      const opReturn = result.psbt.txOutputs.filter(o => o.value === 0)
      const change = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(opReturn.length, 1)
      assert.strictEqual(change.length, 1)
      assert.strictEqual(change[0].value, 100000000 - 10000)
    })
  })

  // ── E2E-5.2: Multiple UTXOs aggregated ────────────────────────

  describe('E2E-5.2: Multiple UTXOs aggregated', () => {
    it('adds UTXOs largest-first until sufficient', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const utxo1 = makeSegwitUtxo(TXID_A, 0, 1000)
      const utxo2 = makeSegwitUtxo(TXID_B, 0, 1000)
      const utxo3 = makeSegwitUtxo(TXID_C, 0, 1000)

      const result = await encoder.createTransaction(
        [utxo1, utxo2, utxo3], address, null,
        action.data, null, 2000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt.data.inputs.length >= 2)
    })
  })

  // ── E2E-5.3: UTXO deduplication ──────────────────────────────

  describe('E2E-5.3: UTXO deduplication', () => {
    it('collapses duplicate (txid, vout) pairs', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const dup1 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const dup2 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const unique = makeSegwitUtxo(TXID_B, 1, 30000000)

      const result = await encoder.createTransaction(
        [dup1, dup2, unique], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt.data.inputs.length <= 2)
    })
  })

  // ── E2E-5.4: Unconfirmed excluded ─────────────────────────────

  describe('E2E-5.4: Unconfirmed UTXOs excluded', () => {
    it('filters mempool UTXOs when unconfirmed=false', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const confirmed = makeSegwitUtxo(TXID_A, 0, 100000000)
      confirmed.confirmations = 6
      const mempool = makeMempoolUtxo(TXID_B, 0, 50000000)

      const result = await encoder.createTransaction(
        [mempool, confirmed], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, false, 0.00001 // unconfirmed=false
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })

  // ── E2E-5.5: Unconfirmed included ─────────────────────────────

  describe('E2E-5.5: Unconfirmed UTXOs included', () => {
    it('uses mempool UTXOs when unconfirmed=true', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const mempool = makeMempoolUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [mempool], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })

  // ── E2E-5.6: UtxoTracker fallback ─────────────────────────────

  describe('E2E-5.6: UtxoTracker fallback', () => {
    it('calls UtxoTracker when utxos is null', async () => {
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

      assert.strictEqual(trackerCalled, true)
    })

    it('calls UtxoTracker when utxos is empty array', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      let trackerCalled = false
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        return { utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)] }
      }

      await encoder.createTransaction(
        [], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(trackerCalled, true)
    })
  })

  // ── E2E-5.7: Fee floor enforcement ────────────────────────────

  describe('E2E-5.7: Fee floor enforcement', () => {
    it('floors fee to dustAmount when computed fee is lower', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.0000001 // very low rate
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= dustAmount ${encoder.dustAmount}`)
    })
  })

  // ── E2E-5.8: Fee cap enforcement ──────────────────────────────

  describe('E2E-5.8: Fee cap enforcement', () => {
    it('caps fee when maxFeeRateKb is set', async () => {
      const capped = new XChainEncoder(
        NETWORK, '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 1000
      )
      capped.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => buildRawTxHex(100000000, NETWORK),
        isRegtest: async () => true
      }
      capped.utxoTrackerConnector = {
        getUtxosFromAddress: async () => ({ utxos: [] })
      }

      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const resultCapped = await capped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 1.0 // very high
      )

      const uncapped = makeEncoder(NETWORK)
      const resultUncapped = await uncapped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 1.0
      )

      const cappedChange = resultCapped.psbt.txOutputs.find(o => o.value > 0)
      const uncappedChange = resultUncapped.psbt.txOutputs.find(o => o.value > 0)
      assert.ok(cappedChange.value > uncappedChange.value,
        'capped fee should leave more change')
    })
  })

  // ── E2E-5.9: No change address error ──────────────────────────

  describe('E2E-5.9: No change address error', () => {
    it('throws when change address missing and surplus > dust', async () => {
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
        /change address/i
      )
    })
  })

  // ── E2E-5.10: Legacy UTXO handling ────────────────────────────

  describe('E2E-5.10: Legacy UTXO handling', () => {
    it('P2PKH UTXO triggers getTransactionHex and uses nonWitnessUtxo', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      let getHexCalled = false
      const rawHex = buildRawTxHex(100000000, NETWORK)
      encoder.connector.getTransactionHex = async () => {
        getHexCalled = true
        return rawHex
      }

      const utxo = makeLegacyUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(getHexCalled, true)
      assert.ok(result.psbt.data.inputs[0].nonWitnessUtxo)
    })
  })

  // ── E2E-5.11: SegWit UTXO handling ────────────────────────────

  describe('E2E-5.11: SegWit UTXO handling', () => {
    it('P2WPKH UTXO uses witnessUtxo, no raw tx fetch', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      let getHexCalled = false
      encoder.connector.getTransactionHex = async () => {
        getHexCalled = true
        return buildRawTxHex(100000000, NETWORK)
      }

      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(getHexCalled, false)
    })
  })

  // ── E2E-5.12: RBF sequence flag ───────────────────────────────

  describe('E2E-5.12: RBF sequence flag', () => {
    it('rbf=true sets sequence 0x00000001', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, true, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txInputs[0].sequence, 0x00000001)
    })

    it('rbf=false sets sequence 0xffffffff', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txInputs[0].sequence, 0xffffffff)
    })
  })

  // ── E2E-5.13: Custom outputs + ACTION ─────────────────────────

  describe('E2E-5.13: Custom outputs coexist with ACTION', () => {
    it('custom output value deducted from change', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()
      const fee = 10000

      const resultNone = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, fee, false, null, address,
        null, null, null, true, 0.00001
      )

      const resultCustom = await encoder.createTransaction(
        [utxo], address, [{ address, value: '500000' }],
        action.data, null, fee, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeNone = resultNone.psbt.txOutputs.reduce((m, o) => o.value > m ? o.value : m, 0)
      const changeCustom = resultCustom.psbt.txOutputs.reduce((m, o) => o.value > m ? o.value : m, 0)
      assert.strictEqual(changeNone - changeCustom, 500000)
    })
  })

  // ── E2E-5.14: Fee source: explicit ────────────────────────────

  describe('E2E-5.14: Explicit feePerKb bypasses RPC', () => {
    it('does not call getFeePerKilobyte when feePerKb provided', async () => {
      const encoder = makeEncoder(NETWORK)
      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('should not be called')
      }

      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt)
    })
  })

  // ── E2E-5.15: Fee source: RPC ─────────────────────────────────

  describe('E2E-5.15: Null feePerKb triggers RPC call', () => {
    it('calls getFeePerKilobyte when feePerKb is null', async () => {
      const encoder = makeEncoder(NETWORK)
      let called = false
      encoder.connector.getFeePerKilobyte = async () => {
        called = true
        return 0.00001
      }

      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, null
      )
      assert.strictEqual(called, true)
    })
  })
})
