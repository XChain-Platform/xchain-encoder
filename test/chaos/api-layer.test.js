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
 * Chaos Engineering: Category F: API Layer Failures
 *
 * Tests validator resilience with malformed params and documents
 * the psbt.toHex() exposure in api.js (outside try/catch).
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const validator = require('../../src/validator')
const {
  TXID_A, TXID_MULTISIGN, PUBKEY_BUF,
  makeSegwitUtxo, makeEncoder, getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const DOGE = 'dogecoin-regtest'
const BTC = 'bitcoin-regtest'
const DOGE_ADDR = getTestAddress(DOGE)
const BTC_ADDR = getTestAddress(BTC)

describe('Chaos Category F: API Layer Failures', () => {

  describe('F-1: Validator with malformed params', () => {
    it('null params → TypeError', () => {
      assert.throws(
        () => validator.validateAll(null),
        { name: 'TypeError' }
      )
    })

    it('string params → TypeError', () => {
      assert.throws(
        () => validator.validateAll('not-an-object'),
        { name: 'TypeError' }
      )
    })

    it('data exceeding 65536 bytes → RangeError', () => {
      assert.throws(
        () => validator.validateAll({ data: 'X'.repeat(65537), pubkey: 'test' }),
        { name: 'RangeError' }
      )
    })

    it('invalid encoding value → TypeError', () => {
      assert.throws(
        () => validator.validateAll({ encoding: 'INVALID', data: 'SEND', pubkey: 'test' }),
        { name: 'TypeError' }
      )
    })

    it('negative fee → RangeError', () => {
      assert.throws(
        () => validator.validateAll({ fee: -1, data: 'SEND', pubkey: 'test' }),
        { name: 'RangeError' }
      )
    })

    it('utxos array exceeding 500 → RangeError', () => {
      const bigUtxos = Array.from({ length: 501 }, (_, i) => ({
        txid: TXID_A, vout: i, value: 100, scriptPubKey: 'aa'.repeat(25)
      }))

      assert.throws(
        () => validator.validateAll({ utxos: bigUtxos, data: 'SEND', pubkey: 'test' }),
        { name: 'RangeError' }
      )
    })

    it('unknown/typoed ACTION name → RangeError', () => {
      assert.throws(
        () => validator.validateAll({ data: 'test', pubkey: 'test' }),
        { name: 'RangeError' }
      )
    })
  })

  // api.js line 124 calls psbt.toHex() OUTSIDE the try/catch block.
  // If toHex() throws, it would be an unhandled error in the API.

  describe('F-3: psbt.toHex() callability (api.js line 124 exposure)', () => {
    it('OP_RETURN result: psbt.toHex() succeeds', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.doesNotThrow(() => result.psbt.toHex())
      assert.strictEqual(typeof result.psbt.toHex(), 'string')
    })

    it('P2SH result: psbt.toHex() succeeds', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeIssueFull().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.doesNotThrow(() => result.psbt.toHex())
    })

    it('MULTISIGN result: psbt.toHex() succeeds', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        'A'.repeat(59), null, 10000, false, 'MULTISIGN', DOGE_ADDR,
        null, null, PUBKEY_BUF.toString('hex'),
        true, 0.00001
      )
      assert.doesNotThrow(() => result.psbt.toHex())
    })
  })

  describe('F-3b: psbt.toHex() monkey-patch (documents api.js exposure)', () => {
    let _origToHex

    before(() => {
      _origToHex = bitcoin.Psbt.prototype.toHex
      bitcoin.Psbt.prototype.toHex = function () {
        throw new Error('chaos: toHex failed')
      }
    })

    after(() => {
      bitcoin.Psbt.prototype.toHex = _origToHex
    })

    it('toHex failure after successful createTransaction → unhandled in api.js', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // createTransaction itself succeeds (toHex is not called inside it)
      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)

      assert.throws(
        () => result.psbt.toHex(),
        /chaos: toHex failed/
      )
    })
  })
})
