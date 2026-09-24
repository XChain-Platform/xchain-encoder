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
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
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


describe('XChainEncoder.createTransaction() - change edge cases', () => {
  it('does not add change output when changeSatoshis is 0', async () => {
    const encoder = makeEncoder()
    // fee == input value is drain-shaped on purpose (to zero the change); the
    // relative fee-rate cap would reject it, so disable the cap for this test.
    encoder.maxFeeRateMultiplier = null
    // dogecoin-regtest's dust floor is 100000 koinu, which is also the fixed
    // burn backstop's effective ceiling here (100x the ~131-sat fair fee is
    // smaller than the dust floor, so the floor wins the max()). Keep the
    // UTXO and fee at that ceiling so the fee is not rejected or floored up.
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000)
    const fee = 100000

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, fee, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )

    // No change output (value 0 is OP_RETURN, no positive change)
    const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
    assert.ok(!changeOutput, 'should not have a positive change output')
  })

  it('does not throw when changeSatoshis <= dustAmount and no change address', async () => {
    const encoder = makeEncoder()
    // Leaving sub-dust change is drain-shaped on purpose; the relative
    // fee-rate cap would reject it, so disable the cap.
    encoder.maxFeeRateMultiplier = null
    // Fee at the dust-floor/burn-backstop ceiling (see comment above), with a
    // slightly larger UTXO so change lands under dogecoin-regtest's
    // 100000-koinu dust floor.
    const utxo = makeP2pkhUtxo(TXID_A, 0, 150000)
    const fee = 100000 // leaves 50000 sats change, below the 100000 dust floor

    // Should not throw; change below dust with no change address is fine (burned as fee)
    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, fee, false, null, null, // no change address
      null, null, null, true, 0.00001
    )

    assert.ok(result.psbt)
  })
})
