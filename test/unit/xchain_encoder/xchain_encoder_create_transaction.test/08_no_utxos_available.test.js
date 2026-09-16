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
  bitcoin,
  pubkeyBuf,
  TXID_A,
  makeSegwitUtxo,
  makeLegacyUtxo,
  makeEncoder,
  LTC_REGTEST,
  TEST_ADDRESS
} = require('./fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {
  describe('no UTXOs available', () => {
    it('throws when utxos is empty and tracker returns nothing', async () => {
      const encoder = makeEncoder()
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: []
      })

      await assert.rejects(
        () => encoder.createTransaction(
          [], TEST_ADDRESS, null,
          'test', null, 10000, false, null, TEST_ADDRESS,
          null, null, null, true, 0.00001
        ),
        /no utxos/i
      )
    })

    it('throws when utxos is null and tracker returns null', async () => {
      const encoder = makeEncoder()
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: null
      })

      await assert.rejects(
        () => encoder.createTransaction(
          null, TEST_ADDRESS, null,
          'test', null, 10000, false, null, TEST_ADDRESS,
          null, null, null, true, 0.00001
        ),
        /no utxos/i
      )
    })

    it('falls back to utxoTracker when utxos param is null', async () => {
      const encoder = makeEncoder()
      let trackerCalled = false
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        return { utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)] }
      }

      await encoder.createTransaction(
        null, TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(trackerCalled, true)
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('no UTXOs available', () => {
    // Regression: every wallet flow sends its source as a raw compressed
    // pubkey hex (xchain-wallet's `source.publicKey`), not an address - the
    // "pubkey" param name is legacy/misleading (validator.js documents it as
    // "actually the sender address"). Before this fix, that raw pubkey hex
    // reached getUtxosFromAddress unresolved, and bitcoinjs-lib's
    // address.toOutputScript rejected it as neither valid base58 nor bech32
    // ("<hex> has no matching Script"), breaking every UTXO-tracker-backed
    // compose (any call that does not pre-supply `utxos`) for a live wallet.
    it('resolves a raw pubkey (not an address) to P2WPKH before querying the tracker on a segwit network', async () => {
      const encoder = makeEncoder()
      let queriedAddress = null
      encoder.utxoTrackerConnector.getUtxosFromAddress = async (address) => {
        queriedAddress = address
        return { utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)] }
      }

      const rawPubkeyHex = pubkeyBuf.toString('hex')
      await encoder.createTransaction(
        null, rawPubkeyHex, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // A segwit-capable network's default address type is P2WPKH.
      const expected = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network: LTC_REGTEST }).address
      assert.strictEqual(queriedAddress, expected)
    })

    // The other branch of the same resolution: a chain without segwit defaults to
    // P2PKH, and its tracker query must carry a base58 address.
    it('resolves a raw pubkey to P2PKH before querying the tracker on a network without segwit', async () => {
      const encoder = makeEncoder('dogecoin-regtest')
      let queriedAddress = null
      encoder.utxoTrackerConnector.getUtxosFromAddress = async (address) => {
        queriedAddress = address
        return { utxos: [makeLegacyUtxo(TXID_A, 0, 100000000)] }
      }

      const dogeNetwork = require('../../../../src/build/crypto_networks').getBitcoinJsNetwork('dogecoin-regtest')
      const dogeAddress = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: dogeNetwork }).address
      const rawPubkeyHex = pubkeyBuf.toString('hex')
      await encoder.createTransaction(
        null, rawPubkeyHex, null,
        'test', null, 10000, false, null, dogeAddress,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(queriedAddress, dogeAddress)
    })
  })
})
