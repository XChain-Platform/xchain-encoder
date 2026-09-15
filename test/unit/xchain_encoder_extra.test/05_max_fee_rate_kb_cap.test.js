// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../src/XChainEncoder')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)

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


describe('XChainEncoder.createTransaction() - maxFeeRateKb cap', () => {
  it('caps the fee rate when connector returns a rate above maxFeeRateKb', async () => {
    // Create encoder with maxFeeRateKb = 1 (sat/kB, very low cap)
    const encoder = new XChainEncoder(
      'dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 1
    )
    encoder.connector = {
      // Return an excessively high fee rate
      getFeePerKilobyte: async () => 1.0, // 1 BTC/kB
      getTransactionHex: async () => RAW_TX_HEX
    }
    encoder.utxoTrackerConnector = {
      getUtxosFromAddress: async () => ({ utxos: [] })
    }

    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, null, false, null, TEST_ADDRESS,
      null, null, null, true, null // null feePerKb → will call connector
    )

    // The fee must be capped; without cap this would consume most of the 1 BTC input
    const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
    const impliedFee = 100000000 - changeOutput.value
    // maxFeeRateKb=1 sat/kB → maxFeePerBytes = 1/1000/100000000 BTC/byte
    // That's tiny (0.00000000001 BTC/byte); floor kicks in at dustAmount
    assert.ok(impliedFee < 100000000 * 0.01,
      `fee ${impliedFee} should be well under 1% of input with cap applied`)
  })
})
