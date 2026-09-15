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

// A bitcoin-regtest address for P2WSH tests (segwit-capable)
const BTC_REGTEST_ADDR = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf,
  network: bitcoin.networks.regtest
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
  const trackerUtxo = encoder.network.supportsSegwit === false ? makeP2pkhUtxo : makeSegwitUtxo
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [trackerUtxo(TXID_A, 0, 100000000)]
    })
  }
  return encoder
}

describe('XChainEncoder.createTransaction(): P2WSH tx2 (spending)', () => {
  it('creates P2WSH input with witnessScript and OP_RETURN marker', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    // Create tx1 first
    const tx1Result = await encoder.createTransaction(
      [utxo], BTC_REGTEST_ADDR, null,
      'test', null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
      null, null, null, true, 0.00001
    )

    // Extract tx1 hex from the PSBT's internal TX
    const tx1Hex = tx1Result.psbt.__CACHE.__TX.toHex()
    const tx1Id = tx1Result.psbt.__CACHE.__TX.getId()

    // Create tx2 (spending)
    const tx2Result = await encoder.createTransaction(
      [utxo], BTC_REGTEST_ADDR, null,
      'test', null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
      tx1Id, tx1Hex, null, true, 0.00001
    )

    assert.strictEqual(tx2Result.encoding, 'P2WSH')
    // tx2 should have at least one input (the P2WSH spend)
    assert.ok(tx2Result.psbt.data.inputs.length >= 1, 'should have at least one input')
    // tx2 should have an OP_RETURN marker output (value 0)
    const opReturnOutput = tx2Result.psbt.txOutputs.find(o => o.value === 0)
    assert.ok(opReturnOutput, 'tx2 should have an OP_RETURN marker output')
  })
})

describe('XChainEncoder.createTransaction(): P2WSH tx2 (spending)', () => {
  it('throws RangeError when p2shHex has no output at the expected voutPsbtIndex', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    // Build a minimal tx with just ONE output but request it for two chunks
    // (The data will be split into 2 chunks but the funding tx only has 1 output)
    const smallTx = new bitcoin.Transaction()
    smallTx.addInput(Buffer.alloc(32, 0x11), 0)
    const script = bitcoin.payments.p2pkh({
      pubkey: pubkeyBuf, network: bitcoin.networks.regtest
    }).output
    smallTx.addOutput(script, 10000) // only 1 P2WSH-sized output at index 0
    const smallTxHex = smallTx.toHex()
    const smallTxId = smallTx.getId()

    // Data that will produce 2 chunks (> 76 bytes for OP_RETURN, so P2WSH means 2 chunks)
    // Each P2WSH chunk uses 476 bytes of data; let's use data > 476 to force 2 chunks
    const bigData = 'x'.repeat(480)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], BTC_REGTEST_ADDR, null,
        bigData, null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
        smallTxId, smallTxHex, null, true, 0.00001
      ),
      { name: 'RangeError', message: /does not have output at index/ }
    )
  })
})

describe('XChainEncoder.createTransaction(): P2WSH tx2 (spending)', () => {
  it('throws RangeError when p2shHex has no output at the expected voutPsbtIndex (P2SH)', async () => {
    // P2SH counterpart to the P2WSH guard above: the reveal branch must bounds-
    // check voutPsbtIndex against the funding tx's outputs before addInput.
    const encoder = makeEncoder() // dogecoin-regtest (P2SH, no segwit)
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    // Funding tx with a SINGLE output, but a payload that splits into >=2 chunks.
    const smallTx = new bitcoin.Transaction()
    smallTx.addInput(Buffer.alloc(32, 0x11), 0)
    const script = bitcoin.payments.p2pkh({
      pubkey: pubkeyBuf, network: bitcoin.networks.regtest
    }).output
    smallTx.addOutput(script, 10000) // only 1 P2SH-sized output at index 0
    const smallTxHex = smallTx.toHex()
    const smallTxId = smallTx.getId()

    // >476 compiled bytes forces 2 P2SH chunks, but the funding tx has 1 output.
    const bigData = 'x'.repeat(480)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, 'P2SH', TEST_ADDRESS,
        smallTxId, smallTxHex, null, true, 0.00001
      ),
      { name: 'RangeError', message: /does not have output at index/ }
    )
  })
})
