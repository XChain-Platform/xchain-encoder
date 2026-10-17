// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Fixtures for PSBT conformance suites: one test key (private key 1, so its public
// key is the curve generator), funding UTXOs of each script type with their whole
// previous transactions, an encoder over a stubbed node, and named-argument builds.

const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../src/XChainEncoder')
const CryptoNetworks = require('../../src/build/crypto_networks')

const ECPair = ECPairFactory(ecc)
const PRIVATE_KEY = Buffer.concat([Buffer.alloc(31), Buffer.from([1])])
const PUBKEY = Buffer.from(ECPair.fromPrivateKey(PRIVATE_KEY).publicKey)
const PUBKEY_HEX = PUBKEY.toString('hex')

function networkOf (key) {
  return CryptoNetworks.getBitcoinJsNetwork(key)
}

// The output script of `kind` for `pubkey` (default: the test key) on `network`.
function paymentFor (kind, network, pubkey = PUBKEY) {
  const net = networkOf(network)
  if (kind === 'p2wpkh') return bitcoin.payments.p2wpkh({ pubkey, network: net })
  if (kind === 'p2pkh') return bitcoin.payments.p2pkh({ pubkey, network: net })
  if (kind === 'p2sh-p2wpkh') return bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network: net }), network: net })
  throw new Error('unknown kind ' + kind)
}

// A UTXO paying `script`, plus its previous transaction registered in `prevTxs`.
function utxoFor (prevTxs, script, value, seed) {
  const tx = new bitcoin.Transaction()
  tx.addInput(crypto.createHash('sha256').update('fixture:' + seed).digest(), 0)
  tx.addOutput(script, value)
  prevTxs.set(tx.getId(), tx.toHex())
  return { txid: tx.getId(), vout: 0, value, confirmations: 6, scriptPubKey: script.toString('hex') }
}

// An encoder whose node answers fee, relay and previous-transaction calls from memory.
function makeEncoder (network, { estimate, relayfee, prevTxs } = {}) {
  const encoder = new XChainEncoder(network, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => estimate,
    getNetworkInfo: async () => ({ relayfee }),
    getTransactionHex: async (txid) => {
      if (!prevTxs || !prevTxs.has(txid)) throw new Error('no previous transaction ' + txid)
      return prevTxs.get(txid)
    }
  }
  return encoder
}

// createTransaction with named arguments, in payload_preparation.js's positional order.
function build (encoder, a) {
  return encoder.createTransaction(
    a.utxos, a.pubkey, a.customOutputs || null, a.data == null ? null : a.data, null,
    a.fee == null ? null : a.fee, false, a.encoding || null, a.change || null,
    a.p2shHash || null, a.p2shHex || null, a.compressedPubKey || null, true,
    a.feePerKb == null ? null : a.feePerKb, null, a.feeQuote || null)
}

function unsignedTx (result) {
  return bitcoin.Transaction.fromBuffer(result.psbt.data.globalMap.unsignedTx.toBuffer())
}

// Input total minus output total of a built PSBT, in base units.
function feeOf (psbt) {
  let total = 0n
  psbt.data.inputs.forEach((input, i) => {
    total += input.witnessUtxo
      ? BigInt(input.witnessUtxo.value)
      : BigInt(bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo).outs[psbt.txInputs[i].index].value)
  })
  for (const out of psbt.txOutputs) total -= BigInt(out.value)
  return total
}

module.exports = { ECPair, PRIVATE_KEY, PUBKEY, PUBKEY_HEX, networkOf, paymentFor, utxoFor, makeEncoder, build, unsignedTx, feeOf }
