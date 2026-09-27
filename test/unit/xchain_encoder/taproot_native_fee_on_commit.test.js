// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//

const assert = require('assert')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../../src/XChainEncoder')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const FEE_KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 8))
const PUBKEY_HEX = Buffer.from(KEY.publicKey).toString('hex')
const TXID = 'a'.repeat(64)
const FEE_ADDR = bitcoin.payments.p2wpkh({
  pubkey: Buffer.from(FEE_KEY.publicKey),
  network: bitcoin.networks.regtest
}).address

function makeSegwitUtxo (network, txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network })
  return { txid, vout, value, confirmations: 6, scriptPubKey: p2wpkh.output.toString('hex') }
}

function makeEncoder () {
  const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async () => { throw new Error('unit test: no node') }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
  }
  return encoder
}

function callerAddress (network) {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network }).address
}

function outputsPaying (psbt, address) {
  return psbt.txOutputs.filter(output => output.address === address)
}

describe('XChainEncoder TAPROOT native fee placement', function () {
  it('puts the native-fee output on the commit transaction', async function () {
    const encoder = makeEncoder()
    const network = encoder.network
    const caller = callerAddress(network)
    const utxos = [makeSegwitUtxo(network, TXID, 0, 10000000)]
    const raw = crypto.randomBytes(9000).toString('binary')
    const result = await encoder.createTransaction(
      utxos, caller, [{ address: FEE_ADDR, value: 5000 }], 'FILE|0|envelope-test', raw,
      null, false, 'TAPROOT', caller, null, null, PUBKEY_HEX)

    assert.notStrictEqual(FEE_ADDR, caller)
    assert.strictEqual(result.encoding, 'TAPROOT')
    assert.strictEqual(outputsPaying(result.psbt, FEE_ADDR).length, 1)
    assert.strictEqual(Number(outputsPaying(result.psbt, FEE_ADDR)[0].value), 5000)
    assert.strictEqual(outputsPaying(result.revealPsbt, FEE_ADDR).length, 0)
    assert.notStrictEqual(result.psbt.txOutputs[result.envelope.commitVout].address, FEE_ADDR)
  })

  it('does not create a native-fee output when custom outputs are null', async function () {
    const encoder = makeEncoder()
    const network = encoder.network
    const caller = callerAddress(network)
    const utxos = [makeSegwitUtxo(network, TXID, 0, 10000000)]
    const raw = crypto.randomBytes(9000).toString('binary')
    const result = await encoder.createTransaction(
      utxos, caller, null, 'FILE|0|envelope-test', raw,
      null, false, 'TAPROOT', caller, null, null, PUBKEY_HEX)

    assert.strictEqual(outputsPaying(result.psbt, FEE_ADDR).length, 0)
    assert.strictEqual(outputsPaying(result.revealPsbt, FEE_ADDR).length, 0)
  })
})
