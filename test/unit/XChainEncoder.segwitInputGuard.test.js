// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Input selection refuses a witness-program UTXO on a chain whose consensus
// rules have no segwit. Such an output is anyone-can-spend there, so a
// witnessUtxo input signs nothing the network enforces and the caller pays a
// real fee for a transaction that protects nothing. The per-coin capability
// flag lives in the coin registry; this pins that the builder honours it.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const CryptoNetworks = require('../../src/CryptoNetworks')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)
const INPUT_VALUE = 100000000

const P2PKH_SCRIPT = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf, network: bitcoin.networks.regtest
}).output

function prevTxHex () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  tx.addOutput(P2PKH_SCRIPT, INPUT_VALUE)
  return tx.toHex()
}

function makeEncoder (networkName) {
  const encoder = new XChainEncoder(
    networkName, '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => prevTxHex()
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('these probes supply their own inputs') }
  }
  return encoder
}

function utxo (script) {
  return {
    txid: TXID_A,
    vout: 0,
    value: INPUT_VALUE,
    confirmations: 6,
    scriptPubKey: script.toString('hex')
  }
}

const P2WPKH = bitcoin.payments.p2wpkh({
  pubkey: pubkeyBuf, network: bitcoin.networks.regtest
}).output

// Witness v1 (taproot), to pin that the guard reads the witness version range
// rather than the v0 opcode alone.
const P2TR = bitcoin.script.compile([bitcoin.opcodes.OP_1, pubkeyBuf.subarray(1)])

function addressFor (networkName) {
  return bitcoin.payments.p2pkh({
    pubkey: pubkeyBuf, network: CryptoNetworks.getBitcoinJsNetwork(networkName)
  }).address
}

function build (encoder, networkName, input) {
  const address = addressFor(networkName)
  return encoder.createTransaction(
    [input], address, null,
    'test', null, 10000, false, null, address,
    null, null, null, true, 0.00001
  )
}

describe('XChainEncoder input selection: segwit inputs on a chain without segwit', () => {

  it('refuses a P2WPKH input on a network the registry marks as having no segwit', async () => {
    const encoder = makeEncoder('dogecoin-regtest')
    assert.strictEqual(encoder.network.supportsSegwit, false, 'fixture network must be the no-segwit case')

    await assert.rejects(
      () => build(encoder, 'dogecoin-regtest', utxo(P2WPKH)),
      {
        name: 'TypeError',
        message: /carries a witness-program scriptPubKey, which this network does not support/
      }
    )
  })

  it('refuses a witness v1 (taproot) input there too, not only witness v0', async () => {
    const encoder = makeEncoder('dogecoin-regtest')

    await assert.rejects(
      () => build(encoder, 'dogecoin-regtest', utxo(P2TR)),
      { name: 'TypeError', message: /does not support \(no segwit\)/ }
    )
  })

  it('names the offending outpoint, so a coin-control caller can drop it', async () => {
    const encoder = makeEncoder('dogecoin-regtest')

    await assert.rejects(
      () => build(encoder, 'dogecoin-regtest', utxo(P2WPKH)),
      (err) => {
        assert.ok(err.message.includes(TXID_A + ':0'), 'got ' + err.message)
        return true
      }
    )
  })

  it('still spends a legacy input on that same network', async () => {
    const encoder = makeEncoder('dogecoin-regtest')
    const result = await build(encoder, 'dogecoin-regtest', utxo(P2PKH_SCRIPT))
    assert.strictEqual(result.psbt.data.inputs.length, 1)
    assert.ok(Buffer.isBuffer(result.psbt.data.inputs[0].nonWitnessUtxo))
  })

  it('leaves the same P2WPKH input alone on a segwit-capable network', async () => {
    const encoder = makeEncoder('litecoin-regtest')
    const result = await build(encoder, 'litecoin-regtest', utxo(P2WPKH))
    assert.strictEqual(result.psbt.data.inputs.length, 1)
    assert.ok(result.psbt.data.inputs[0].witnessUtxo, 'a segwit chain keeps the witnessUtxo path')
  })
})
