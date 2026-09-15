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
const XChainEncoder = require('../../../../src/XChainEncoder')

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

const DOGE_REGTEST = require('../../../../src/build/crypto_networks').getBitcoinJsNetwork('dogecoin-regtest')
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


// Remaining uncovered branches: customOutputs invalid value, UTXO invalid value,
// unconfirmed=false depletes all UTXOs, changeSatoshis non-finite.
describe('XChainEncoder.createTransaction() - remaining branch coverage', () => {
  it('throws RangeError when customOutputs[i].value is not a valid satoshi amount', async () => {
    const encoder = makeEncoder()
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, [{ address: TEST_ADDRESS, value: 'bad' }],
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /customOutputs\[0\].value must be a non-negative integer/ }
    )
  })

  it('throws RangeError when customOutputs[i].value is negative', async () => {
    const encoder = makeEncoder()
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, [{ address: TEST_ADDRESS, value: -1 }],
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /customOutputs\[0\].value must be a non-negative integer/ }
    )
  })
})

describe('XChainEncoder.createTransaction() - remaining branch coverage', () => {
  it('throws RangeError when a UTXO value is not a valid satoshi amount', async () => {
    const encoder = makeEncoder()
    // A UTXO with a NaN value string (parsed inside the UTXO loop)
    const badUtxo = makeP2pkhUtxo(TXID_A, 0, 'notanumber')

    await assert.rejects(
      () => encoder.createTransaction(
        [badUtxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /utxos\[0\].value must be a non-negative integer/ }
    )
  })

  it('throws when unconfirmed=false strips all UTXOs (line 325 path)', async () => {
    const encoder = makeEncoder()
    // All UTXOs have confirmations=0 (mempool), unconfirmed=false strips them all
    const mempoolUtxo = makeP2pkhUtxo(TXID_A, 0, 100000000)
    mempoolUtxo.confirmations = 0

    await assert.rejects(
      () => encoder.createTransaction(
        [mempoolUtxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null,
        false, // unconfirmed=false → strips the mempool UTXO
        0.00001
      ),
      /no utxos were provided and no utxos found on the blockchain/
    )
  })
})
