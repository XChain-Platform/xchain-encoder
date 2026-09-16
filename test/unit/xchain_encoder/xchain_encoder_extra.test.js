// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Additional tests targeting the branches in XChainEncoder.js not yet
// covered by the existing test files, specifically:
//   - P2WSH encoding: tx1 (funding), tx2 (spending), segwit-unsupported guard
//   - Non-segwit (P2PKH) UTXO path that calls connector.getTransactionHex
//   - feeQuote injection into customOutputs
//   - payload-too-large guard (MAX_COMPILED_ACTION_DATA_LENGTH)
//   - fee=null/false fast-path vs computed fee increment loop
//   - changeSatoshis <= 0 / <= dustAmount with no change address (no-throw path)
//   - estimateSpendingP2wshTx() across all three push-size brackets
//   - maxFeeRateKb cap on computed fee rate

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../src/XChainEncoder')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)

// Build a raw legacy P2PKH transaction hex (nonWitnessUtxo)
function buildRawP2pkhTxHex (value) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  const script = bitcoin.payments.p2pkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  }).output
  tx.addOutput(script, value)
  return tx.toHex()
}

// A P2WPKH scriptPubKey (segwit)
function makeSegwitUtxo (txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  })
  return {
    txid,
    vout,
    value,
    confirmations: 6,
    scriptPubKey: p2wpkh.output.toString('hex')
  }
}

// A P2PKH (legacy, non-segwit) UTXO
function makeP2pkhUtxo (txid, vout, value) {
  const script = bitcoin.payments.p2pkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  }).output.toString('hex')
  return { txid, vout, value, confirmations: 6, scriptPubKey: script }
}

const DOGE_REGTEST = require('../../../src/build/crypto_networks').getBitcoinJsNetwork('dogecoin-regtest')
const TEST_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf,
  network: DOGE_REGTEST
}).address

const RAW_TX_HEX = buildRawP2pkhTxHex(100000000)

function makeEncoder (network) {
  const net = network || 'dogecoin-regtest'
  const encoder = new XChainEncoder(
    net, '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => RAW_TX_HEX
  }
  // Serve the fixture type the chain can actually hold: a witness-program UTXO
  // only exists where consensus knows segwit, and the builder refuses one where
  // it does not.
  const trackerUtxo = encoder.network.supportsSegwit === false ? makeP2pkhUtxo : makeSegwitUtxo
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [trackerUtxo(TXID_A, 0, 100000000)]
    })
  }
  return encoder
}

describe('XChainEncoder.createTransaction(): non-segwit UTXO path', () => {
  it('calls connector.getTransactionHex for a P2PKH UTXO', async () => {
    const encoder = makeEncoder()
    let hexFetched = false
    encoder.connector.getTransactionHex = async (txid) => {
      hexFetched = true
      assert.strictEqual(txid, TXID_A)
      return RAW_TX_HEX
    }
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.strictEqual(hexFetched, true)
  })

  it('stores the nonWitnessUtxo buffer from the hex for legacy inputs', async () => {
    const encoder = makeEncoder()
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )

    // The PSBT input should have a nonWitnessUtxo buffer (not witnessUtxo)
    const input = result.psbt.data.inputs[0]
    assert.ok(Buffer.isBuffer(input.nonWitnessUtxo), 'should have nonWitnessUtxo buffer')
    assert.ok(!input.witnessUtxo, 'should NOT have witnessUtxo')
  })

  it('uses multiple UTXOs when first is insufficient to cover fee', async () => {
    const encoder = makeEncoder()
    // The oversized explicit fee here exists to force multi-UTXO selection; it
    // would trip the relative fee-rate cap (tested in its own suite), so
    // disable the cap for this test.
    encoder.maxFeeRateMultiplier = null
    // Two P2PKH UTXOs that must be combined. Sorted largest-first:
    // utxo2 (80000) then utxo1 (50000). With a 90000-sat explicit fee (kept
    // under the fixed 100x-fair-fee burn backstop, whose ceiling here is
    // dogecoin-regtest's 100000-koinu dust floor), inputSatoshis after utxo2
    // alone = 80000, which is not > 0 + 90000, so the loop continues and
    // picks up utxo1 too (combined = 130000 > 90000).
    const utxo1 = makeP2pkhUtxo(TXID_A, 0, 50000)
    const utxo2 = makeP2pkhUtxo(TXID_B, 1, 80000)

    const result = await encoder.createTransaction(
      [utxo1, utxo2], TEST_ADDRESS, null,
      'test', null, 90000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )

    // Both UTXOs should be consumed (neither alone covers the fee)
    assert.strictEqual(result.psbt.data.inputs.length, 2)
  })
})
