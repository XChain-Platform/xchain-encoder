// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The P2SH/P2WSH reveal keys its OP_RETURN marker off the funding transaction
// parsed from p2shHex, but spends outpoints named by the separately supplied
// p2shHash. Nothing bound the two, so a caller mixing the id of one funding tx
// with the hex of an equivalent other one built a signable reveal whose marker
// the decoder could never decrypt: the ACTION is dropped and the inputs are
// spent anyway. These tests pin the equality guard ().

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)
// A syntactically valid txid that is NOT the id of any funding tx built here.
const TXID_WRONG = 'b'.repeat(64)

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

const RAW_TX_HEX = buildRawP2pkhTxHex(100000000)

const BTC_REGTEST_ADDR = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf,
  network: bitcoin.networks.regtest
}).address

const DOGE_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('dogecoin-regtest')
const DOGE_REGTEST_ADDR = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf,
  network: DOGE_REGTEST
}).address

function makeEncoder (network) {
  const encoder = new XChainEncoder(
    network || 'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => RAW_TX_HEX
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)]
    })
  }
  return encoder
}

// Build the phase-1 funding tx and hand back {hex, id} for the reveal call.
async function buildFunding (encoder, encoding, address) {
  const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
  const funding = await encoder.createTransaction(
    [utxo], address, null,
    'x'.repeat(80), null, 10000, false, encoding, address,
    null, null, null, true, 0.00001
  )
  return {
    hex: funding.psbt.__CACHE.__TX.toHex(),
    id: funding.psbt.__CACHE.__TX.getId()
  }
}

describe('XChainEncoder reveal: p2shHash must be the id of p2shHex ()', () => {
  it('rejects a P2WSH reveal whose p2shHash is not the funding tx id', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const funding = await buildFunding(encoder, 'P2WSH', BTC_REGTEST_ADDR)
    assert.notStrictEqual(funding.id, TXID_WRONG)

    await assert.rejects(
      () => encoder.createTransaction(
        [], BTC_REGTEST_ADDR, null,
        'x'.repeat(80), null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
        TXID_WRONG, funding.hex, null, true, 0.00001
      ),
      { name: 'TypeError', message: /does not match the txid of the supplied p2shHex/ }
    )
  })

  it('rejects a P2SH reveal whose p2shHash is not the funding tx id', async () => {
    const encoder = makeEncoder('dogecoin-regtest')
    const funding = await buildFunding(encoder, 'P2SH', DOGE_REGTEST_ADDR)
    assert.notStrictEqual(funding.id, TXID_WRONG)

    await assert.rejects(
      () => encoder.createTransaction(
        [], DOGE_REGTEST_ADDR, null,
        'x'.repeat(80), null, 10000, false, 'P2SH', DOGE_REGTEST_ADDR,
        TXID_WRONG, funding.hex, null, true, 0.00001
      ),
      { name: 'TypeError', message: /does not match the txid of the supplied p2shHex/ }
    )
  })

  it('still builds a P2WSH reveal when p2shHash is the funding tx id', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const funding = await buildFunding(encoder, 'P2WSH', BTC_REGTEST_ADDR)

    const reveal = await encoder.createTransaction(
      [], BTC_REGTEST_ADDR, null,
      'x'.repeat(80), null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
      funding.id, funding.hex, null, true, 0.00001
    )

    assert.strictEqual(reveal.encoding, 'P2WSH')
    assert.ok(reveal.psbt.data.inputs.length >= 1, 'reveal should spend the funding output(s)')
  })

  it('still builds a P2SH reveal when p2shHash is the funding tx id', async () => {
    const encoder = makeEncoder('dogecoin-regtest')
    const funding = await buildFunding(encoder, 'P2SH', DOGE_REGTEST_ADDR)

    const reveal = await encoder.createTransaction(
      [], DOGE_REGTEST_ADDR, null,
      'x'.repeat(80), null, 10000, false, 'P2SH', DOGE_REGTEST_ADDR,
      funding.id, funding.hex, null, true, 0.00001
    )

    assert.strictEqual(reveal.encoding, 'P2SH')
    assert.ok(reveal.psbt.data.inputs.length >= 1, 'reveal should spend the funding output(s)')
  })

  it('accepts an uppercase p2shHash that names the same funding tx', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const funding = await buildFunding(encoder, 'P2WSH', BTC_REGTEST_ADDR)

    const reveal = await encoder.createTransaction(
      [], BTC_REGTEST_ADDR, null,
      'x'.repeat(80), null, 10000, false, 'P2WSH', BTC_REGTEST_ADDR,
      funding.id.toUpperCase(), funding.hex, null, true, 0.00001
    )

    assert.strictEqual(reveal.encoding, 'P2WSH')
  })
})
