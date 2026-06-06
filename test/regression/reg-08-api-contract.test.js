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
 * REG-08: API Contract Regression
 *
 * Tests the validator → encoder flow without starting an HTTP server.
 * Verifies parameter marshalling from validateAll() through createTransaction(),
 * error classification (validation vs encoder errors), and PSBT serialization.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { validateAll } = require('../../src/validator')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

/**
 * Simulate the api.js create_tx handler flow:
 * 1. validateAll(rawParams) — may throw TypeError/RangeError (→ -32602)
 * 2. encoder.createTransaction(validated) — may throw Error (→ -32603)
 * 3. return { psbt: psbt.toHex(), encoding }
 */
async function simulateCreateTx (rawParams, encoder) {
  const validated = validateAll(rawParams)
  const result = await encoder.createTransaction(
    validated.utxos,
    validated.pubkey,
    validated.customOutputs,
    validated.data,
    validated.rawData,
    validated.fee,
    validated.rbf,
    validated.encoding,
    validated.change,
    validated.p2shHash,
    validated.p2shHex,
    validated.compressedPubKey,
    validated.unconfirmed,
    validated.feePerKb,
    validated.dust
  )
  return {
    psbt: result.psbt.toHex(),
    encoding: result.encoding
  }
}

describe('REG-08: API Contract Regression', function () {

  // ── REG-08.1: Parameter flow ──────────────────────────────────

  describe('REG-08.1: validateAll → createTransaction parameter mapping', function () {
    it('valid params flow through without error', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const result = await simulateCreateTx({
        data: action.data,
        pubkey: address,
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        fee: '10000',
        change: address,
        feePerKb: 0.00001
      }, encoder)

      assert.ok(result.psbt, 'should return psbt hex')
      assert.ok(result.encoding, 'should return encoding')
    })

    it('utxos passed as array are forwarded correctly', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const result = await simulateCreateTx({
        data: action.data,
        pubkey: address,
        utxos: [
          makeSegwitUtxo(TXID_A, 0, 50000000),
          makeSegwitUtxo(TXID_A, 1, 50000000)
        ],
        fee: '10000',
        change: address,
        feePerKb: 0.00001
      }, encoder)

      assert.ok(result.psbt)
    })

    it('fee=null flows through as null (auto-fee mode)', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const result = await simulateCreateTx({
        data: action.data,
        pubkey: address,
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        fee: null,
        change: address,
        feePerKb: 0.00001
      }, encoder)

      assert.ok(result.psbt)
    })

    it('feePerKb bypasses RPC call', async function () {
      const encoder = makeEncoder(NETWORK)
      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('should not call RPC')
      }
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const result = await simulateCreateTx({
        data: action.data,
        pubkey: address,
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        change: address,
        feePerKb: 0.00001
      }, encoder)

      assert.ok(result.psbt)
    })
  })

  // ── REG-08.2: Validation errors (would be -32602) ────────────

  describe('REG-08.2: Validation errors (code -32602 pattern)', function () {
    it('invalid encoding value produces TypeError', function () {
      assert.throws(
        () => validateAll({ data: 'SEND|0|X|1|addr', encoding: 'INVALID' }),
        { name: 'TypeError' }
      )
    })

    it('negative fee produces RangeError', function () {
      assert.throws(
        () => validateAll({ data: 'SEND|0|X|1|addr', fee: -1 }),
        { name: 'RangeError' }
      )
    })

    it('null params produces TypeError', function () {
      assert.throws(
        () => validateAll(null),
        { name: 'TypeError' }
      )
    })

    it('data > 65536 bytes produces RangeError', function () {
      assert.throws(
        () => validateAll({ data: 'x'.repeat(65537) }),
        { name: 'RangeError' }
      )
    })
  })

  // ── REG-08.3: Encoder errors (would be -32603) ───────────────

  describe('REG-08.3: Encoder errors (code -32603 pattern)', function () {
    it('no UTXOs error is a plain Error', async function () {
      const encoder = makeEncoder(NETWORK)
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: [] })
      const address = getTestAddress(NETWORK)

      const validated = validateAll({
        data: 'SEND|0|X|1|addr',
        pubkey: address,
        change: address,
        feePerKb: 0.00001
      })

      await assert.rejects(
        () => encoder.createTransaction(
          validated.utxos, validated.pubkey, validated.customOutputs,
          validated.data, validated.rawData, validated.fee, validated.rbf,
          validated.encoding, validated.change, validated.p2shHash, validated.p2shHex,
          validated.compressedPubKey, validated.unconfirmed, validated.feePerKb, validated.dust
        ),
        (err) => {
          assert.ok(err instanceof Error)
          assert.ok(err.message.includes('no utxos'))
          return true
        }
      )
    })
  })

  // ── REG-08.4: PSBT serialization ──────────────────────────────

  describe('REG-08.4: PSBT serialization', function () {
    it('result.psbt hex is non-empty and valid hex', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const result = await simulateCreateTx({
        data: action.data,
        pubkey: address,
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        fee: '10000',
        change: address,
        feePerKb: 0.00001
      }, encoder)

      assert.ok(result.psbt.length > 0)
      assert.ok(/^[0-9a-f]+$/i.test(result.psbt))
    })

    it('psbt hex can be parsed back by Psbt.fromHex()', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const result = await simulateCreateTx({
        data: action.data,
        pubkey: address,
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        fee: '10000',
        change: address,
        feePerKb: 0.00001
      }, encoder)

      const parsed = bitcoin.Psbt.fromHex(result.psbt, {
        network: bitcoin.networks.regtest
      })
      assert.ok(parsed, 'should parse without error')
      assert.ok(parsed.txInputs.length > 0, 'parsed PSBT should have inputs')
    })

    it('encoding is one of the four valid encoding strings', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const result = await simulateCreateTx({
        data: action.data,
        pubkey: address,
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        fee: '10000',
        change: address,
        feePerKb: 0.00001
      }, encoder)

      const validEncodings = ['OP_RETURN', 'P2SH', 'MULTISIGN', 'P2WSH']
      assert.ok(validEncodings.includes(result.encoding),
        `encoding "${result.encoding}" should be one of ${validEncodings}`)
    })
  })
})
