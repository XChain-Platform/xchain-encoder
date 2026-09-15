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

describe('XChainEncoder.createTransaction(): P2WSH tx1 (funding)', () => {
  it('throws TypeError when P2WSH is used on a no-segwit network', async () => {
    // dogecoin-regtest has supportsSegwit=false
    const encoder = makeEncoder('dogecoin-regtest')
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, 'P2WSH', TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'TypeError', message: /P2WSH encoding is not supported/ }
    )
  })
})

describe('XChainEncoder.createTransaction(): P2WSH tx1 (funding)', () => {
  it('creates P2WSH output for small data on a segwit-capable network', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    const result = await encoder.createTransaction(
      [utxo], BTC_REGTEST_ADDR, null,
      'test', null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
      null, null, null, true, 0.00001
    )

    assert.strictEqual(result.encoding, 'P2WSH')
    // Should have at least one non-zero output (the P2WSH data output)
    const nonZeroOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
    assert.ok(nonZeroOutputs.length >= 1)
  })

  it('P2WSH output value covers at least the dust floor', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    const result = await encoder.createTransaction(
      [utxo], BTC_REGTEST_ADDR, null,
      'test', null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
      null, null, null, true, 0.00001
    )

    const p2wshOutput = result.psbt.txOutputs.find(o =>
      o.value > 0 && o.value < 100000000 && o.value !== 10000
    )
    assert.ok(p2wshOutput, 'should have a P2WSH data output')
    assert.ok(p2wshOutput.value >= encoder.dustAmount,
      `P2WSH output value ${p2wshOutput.value} should be >= dust ${encoder.dustAmount}`)
  })

  it('total outputs do not exceed total inputs for P2WSH tx1', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const inputValue = 100000000
    const utxo = makeSegwitUtxo(TXID_A, 0, inputValue)

    const result = await encoder.createTransaction(
      [utxo], BTC_REGTEST_ADDR, null,
      'test', null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
      null, null, null, true, 0.00001
    )

    const outputTotal = result.psbt.txOutputs.reduce((sum, o) => sum + o.value, 0)
    assert.ok(outputTotal <= inputValue,
      `total outputs (${outputTotal}) must not exceed total inputs (${inputValue})`)
  })
})
