// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
  assert,
  TXID_A,
  makeSegwitUtxo,
  makeLegacyUtxo,
  makeEncoder,
  TEST_ADDRESS,
  bitcoin,
  pubkeyBuf
} = require('./fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {
  describe('fee handling', () => {
    it('uses custom fee when provided', async () => {
      const encoder = makeEncoder()
      // The relative fee-rate cap has its own suite (xchain_encoder_fee_rate_cap.test.js)
      // and the absolute burn backstop has its own test below; disable/isolate
      // both here so only the passthrough behaviour is under test.
      encoder.maxFeeRateMultiplier = null
      // Isolate the custom-fee passthrough from the network dust floor (exercised
      // by the dust-floor tests below); a fee at or above dust would otherwise be
      // floored up and mask the value being tested.
      encoder.dustAmount = 546
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      // Kept under the 100x-fair-fee burn backstop (fair fee ~131 sats for this
      // ~131-byte tx, so the backstop ceiling is ~13100 sats).
      const customFee = 5000

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, customFee, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Change = input - fee (no other outputs besides OP_RETURN which is 0)
      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.strictEqual(changeOutput.value, 100000000 - customFee)
    })

    it('throws RangeError when the custom fee exceeds 100x the fair-fee estimate (burn backstop)', async () => {
      const encoder = makeEncoder()
      // Disable the relative rate cap so the fixed burn backstop is the only
      // guard in play; the backstop holds even with the rate cap turned off.
      encoder.maxFeeRateMultiplier = null
      encoder.dustAmount = 546
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      // Fair fee is ~131 sats for this ~131-byte tx, so the backstop ceiling
      // is ~13100 sats; 20000 is comfortably over it.
      const customFee = 20000

      await assert.rejects(
        encoder.createTransaction(
          [utxo], TEST_ADDRESS, null,
          'test', null, customFee, false, null, TEST_ADDRESS,
          null, null, null, true, 0.00001
        ),
        (err) => err instanceof RangeError && /100x the estimated fair fee/.test(err.message)
      )
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('fee handling', () => {
    it('floors a node-derived fee to dustAmount when computed fee is lower', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, null, false, null, TEST_ADDRESS,
        null, null, null, true, null
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= dustAmount ${encoder.dustAmount}`)
    })

    it('resolves relayfee when feePerKb is provided', async () => {
      const encoder = makeEncoder()
      let networkInfoCalled = false
      encoder.connector.getNetworkInfo = async () => {
        networkInfoCalled = true
        return { relayfee: 0.00001 }
      }
      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('estimate unavailable')
      }
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, null, false, null, TEST_ADDRESS,
        null, null, null, true, 2000
      )
      assert.ok(result.psbt)
      assert.strictEqual(networkInfoCalled, true)
    })

    it('calls connector.getFeePerKilobyte when feePerKb is null', async () => {
      const encoder = makeEncoder()
      let called = false
      encoder.connector.getFeePerKilobyte = async () => {
        called = true
        return 0.00001
      }
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, null, false, null, TEST_ADDRESS,
        null, null, null, true, null
      )
      assert.strictEqual(called, true)
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('Dogecoin relay fee floor', () => {
    function dogecoinBuild () {
      const encoder = makeEncoder('dogecoin-testnet')
      encoder.connector.getNetworkInfo = async () => ({ relayfee: 0.001 })
      encoder.connector.getFeePerKilobyte = async () => 0.1
      const address = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: encoder.network }).address
      const utxo = makeLegacyUtxo(TXID_A, 0, 1000000000)
      return { encoder, address, utxo }
    }

    it('rejects caller feePerKb below the size-adjusted relay minimum', async () => {
      const { encoder, address, utxo } = dogecoinBuild()
      await assert.rejects(
        encoder.createTransaction(
          [utxo], address, null,
          'test', null, null, false, null, address,
          null, null, null, true, 1
        ),
        (err) => err instanceof RangeError &&
          /feePerKb 1 base units\/kB produces fee \d+, below the node relay minimum \d+ base units/.test(err.message)
      )
    })

    it('rejects an explicit fee below the size-adjusted relay minimum', async () => {
      const { encoder, address, utxo } = dogecoinBuild()
      await assert.rejects(
        encoder.createTransaction(
          [utxo], address, null,
          'test', null, 1, false, null, address,
          null, null, null, true, null
        ),
        (err) => err instanceof RangeError &&
          /fee 1 is below the node relay minimum \d+ base units/.test(err.message)
      )
    })
  })
})
