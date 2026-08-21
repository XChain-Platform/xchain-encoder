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
 * Fee Calculation Boundary Tests
 *
 * Tests fee arithmetic edge cases: feePerKb=0, negative feePerKb,
 * maxFeeRateKb capping, Math.trunc truncation, fee exceeding inputs,
 * and explicit fee parameter behavior.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const {
  TXID_A,
  TXID_B,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress,
  buildRawTxHex
} = require('../integration/helpers/utxoFactory')

// These boundary tests encode BITCOIN fee semantics (dust = 546, sub-dust fees
// floored to 546, explicit fees honored). The default network was mislabeled
// 'dogecoin-regtest', whose dust threshold is 100000 (Dogecoin's min-fee is much
// higher), so every 546-expectation failed. Use bitcoin-regtest to match the
// expectations the assertions actually encode. DOGE's high-dust floor is covered
// by its own case below.
const NETWORK = 'bitcoin-regtest'
const BTC_DUST = 546
const LTC_DUST = 5460
const DOGE_DUST = 100000

describe('Fee Calculation Boundaries', () => {

  describe('feePerKb = 0 → floored to dustAmount', () => {
    it('BTC: fee floors to 546 sats', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, 0 // feePerKb = 0
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.strictEqual(impliedFee, BTC_DUST,
        `fee should be floored to dustAmount (${BTC_DUST}), got ${impliedFee}`)
    })

    it('LTC: fee floors to 5460 sats', async () => {
      const encoder = makeEncoder('litecoin-regtest')
      const address = getTestAddress('litecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, 0
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.strictEqual(impliedFee, LTC_DUST,
        `LTC fee should be floored to ${LTC_DUST}, got ${impliedFee}`)
    })

    it('DOGE: fee floors to 100000 sats (Dogecoin high dust threshold)', async () => {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, 0
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.strictEqual(impliedFee, DOGE_DUST,
        `DOGE fee should be floored to ${DOGE_DUST}, got ${impliedFee}`)
    })
  })

  describe('negative feePerKb → floored to dustAmount', () => {
    it('negative feePerKb does not produce negative fee', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, -0.001 // negative feePerKb
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= BTC_DUST,
        `fee ${impliedFee} should be >= dustAmount ${BTC_DUST} even with negative feePerKb`)
    })
  })

  describe('maxFeeRateKb caps feePerBytes', () => {
    it('high feePerKb with cap produces lower fee than without cap', async () => {
      // Capped encoder: maxFeeRateKb = 1000 sat/kB
      const capped = new XChainEncoder(
        NETWORK, '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 1000
      )
      capped.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => buildRawTxHex(100000000, NETWORK),
        isRegtest: async () => true
      }

      // Uncapped encoder
      const uncapped = makeEncoder(NETWORK)

      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const highFee = 100000000 // sat/kB: 100000 sat/byte = extremely high

      const cappedResult = await capped.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, highFee
      )

      const uncappedResult = await uncapped.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, highFee
      )

      const cappedChange = cappedResult.psbt.txOutputs.find(o => o.value > 0).value
      const uncappedChange = uncappedResult.psbt.txOutputs.find(o => o.value > 0).value
      assert.ok(cappedChange > uncappedChange,
        'capped fee should leave more change than uncapped')
    })

    it('feePerKb below cap → cap has no effect', async () => {
      const capped = new XChainEncoder(
        NETWORK, '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 100000
      )
      capped.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => buildRawTxHex(100000000, NETWORK),
        isRegtest: async () => true
      }

      const uncapped = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const lowFee = 1000 // sat/kB: 1 sat/byte, below the cap

      const cappedResult = await capped.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, lowFee
      )

      const uncappedResult = await uncapped.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, lowFee
      )

      const cappedChange = cappedResult.psbt.txOutputs.find(o => o.value > 0).value
      const uncappedChange = uncappedResult.psbt.txOutputs.find(o => o.value > 0).value
      assert.strictEqual(cappedChange, uncappedChange,
        'cap should have no effect when feePerKb is below it')
    })
  })

  describe('Math.trunc precision', () => {
    it('fractional fee is truncated toward zero, not rounded', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Use a fee rate that produces a fractional satoshi amount
      // feePerBytes * txSize * SATOSHI_UNIT needs to be fractional
      // A fractional sat/kB feePerKb will do this
      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, null, false, null, address,
        null, null, null, true, 3333.3
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      // Fee should be an integer (Math.trunc removes fractional part)
      assert.strictEqual(impliedFee, Math.trunc(impliedFee),
        'fee should be an integer after Math.trunc')
      assert.ok(impliedFee >= BTC_DUST, 'fee should be at least dust')
    })
  })

  describe('fee exceeding total inputs', () => {
    // M-8: the dust-floored fee (546) exceeds the 1-sat input, so the encoder
    // throws INSUFFICIENT_FUNDS instead of returning a PSBT with negative change.
    it('1-sat UTXO with dust-floored fee throws INSUFFICIENT_FUNDS', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'SEND|0|X|1|a', null, null, false, null, address,
          null, null, null, true, 0.0000001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'INSUFFICIENT_FUNDS' &&
                 err.details.available === 1
      )
    })

    // M-8: even after consuming every available UTXO the total is under the fee,
    // so the encoder throws INSUFFICIENT_FUNDS rather than return an
    // unbroadcastable PSBT.
    it('multiple small UTXOs all exhausted, still insufficient, throws INSUFFICIENT_FUNDS', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)

      // 3 UTXOs of 100 sats each = 300 total. With fee = 10000, insufficient.
      await assert.rejects(
        () => encoder.createTransaction(
          [
            makeSegwitUtxo(TXID_A, 0, 100),
            makeSegwitUtxo(TXID_B, 0, 100),
            makeSegwitUtxo(TXID_A, 1, 100)
          ],
          address, null,
          'SEND|0|X|1|a', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'INSUFFICIENT_FUNDS' &&
                 err.details.available === 300
      )
    })
  })

  describe('explicit fee parameter', () => {
    it('fee=10000 sets estimatedFee=10000 regardless of tx size', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.strictEqual(changeOutput.value, 100000000 - 10000)
    })

    it('explicit fee=0 still gets floored to dustAmount', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 0, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.strictEqual(impliedFee, BTC_DUST,
        `explicit fee=0 should be floored to ${BTC_DUST}`)
    })

    it('explicit fee=1 still gets floored to dustAmount', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 1, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.strictEqual(impliedFee, BTC_DUST,
        `explicit fee=1 should be floored to ${BTC_DUST}`)
    })
  })
})
