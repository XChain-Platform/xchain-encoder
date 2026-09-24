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
const crypto = require('crypto')
const XChainEncoder = require('../../../../../src/XChainEncoder')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
// A valid-looking 64-char hex txid
const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)
// A TXID that produces valid EC points when used with MULTISIGN test data
// (found by brute-force: 'A'.repeat(59) compiled to 60 bytes → 64-byte chunk after magic)
const TXID_MS = '4e3472b63a459d2188711abcff6aa2548948f90c527aa60ec4a1101136879fe8'

function buildRawTxHex (value) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  const p2pkhScript = bitcoin.payments.p2pkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  }).output
  tx.addOutput(p2pkhScript, value)
  return tx.toHex()
}

const RAW_TX_HEX = buildRawTxHex(100000000) // 1 BTC in sats

// Build P2WPKH UTXO fixtures. The scriptPubKey is the witness program itself,
// so it is network-independent and valid on any segwit-capable regtest chain.
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

// P2PKH fixture for the chains without segwit, whose UTXOs can only be legacy.
function makeLegacyUtxo (txid, vout, value) {
  const p2pkh = bitcoin.payments.p2pkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  })
  return {
    txid,
    vout,
    value,
    confirmations: 6,
    scriptPubKey: p2pkh.output.toString('hex')
  }
}

// Segwit-capable network, because every fixture below spends a P2WPKH input and
// the builder refuses a witness-program input on a chain without segwit. It also
// carries a dustThreshold, which the change math reads.
function makeEncoder (networkName = 'litecoin-regtest') {
  const encoder = new XChainEncoder(
    networkName, '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    // Returns a bare hex STRING, which is what BlockchainConnector.getTransactionHex
    // actually resolves with (`responseData.result.hex`). An `{ hex }` answer
    // models a shape the real class has never returned. The segwit path requires
    // the transaction too, so the mock must match the code under test.
    getTransactionHex: async () => RAW_TX_HEX
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)]
    })
  }
  return encoder
}

const LTC_REGTEST = require('../../../../../src/build/crypto_networks').getBitcoinJsNetwork('litecoin-regtest')
const TxSizeEstimator = require('../../../../../src/build/tx_size_estimator');
const TEST_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf,
  network: LTC_REGTEST
}).address

module.exports = {
  assert,
  bitcoin,
  crypto,
  XChainEncoder,
  pubkeyBuf,
  TXID_A,
  TXID_B,
  TXID_MS,
  RAW_TX_HEX,
  makeSegwitUtxo,
  makeLegacyUtxo,
  makeEncoder,
  LTC_REGTEST,
  TxSizeEstimator,
  TEST_ADDRESS
}
