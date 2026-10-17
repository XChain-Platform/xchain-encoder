// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Shared fixture for the build-correctness suites: an encoder with a stubbed node,
// UTXOs backed by real previous transactions, and value accounting read straight off
// the PSBT after every input is filled with a worst-case signature, so a test measures
// the size and fee rate the network will actually see.

'use strict'

const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../../../src/XChainEncoder')
const CryptoNetworks = require('../../../../../src/build/crypto_networks')

// Generator point G (private key 1); only its public half is needed.
const PUB = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
const PUB_HEX = PUB.toString('hex')
// A 72-byte DER signature plus sighash byte, the longest a low-S signature gets.
const SIG72 = Buffer.concat([Buffer.from([0x30, 0x45]), Buffer.alloc(69, 0x11), Buffer.from([0x01])])

// Node rates per coin in coin/kB: relayfee, and the estimate the node quotes.
const NETS = {
  btc: { key: 'bitcoin-regtest', relay: 0.00001, est: 0.0001 },
  ltc: { key: 'litecoin-regtest', relay: 0.00001, est: 0.0001 },
  doge: { key: 'dogecoin-regtest', relay: 0.001, est: 0.01 }
}

const PREV = new Map()
let prevSeq = 0

function net (coin) { return CryptoNetworks.getBitcoinJsNetwork(NETS[coin].key) }
function p2pkhAddr (coin) { return bitcoin.payments.p2pkh({ pubkey: PUB, network: net(coin) }).address }
function p2wpkhAddr (coin) { return bitcoin.payments.p2wpkh({ pubkey: PUB, network: net(coin) }).address }
function otherAddr (coin) { return bitcoin.payments.p2pkh({ hash: Buffer.alloc(20, 0x22), network: net(coin) }).address }
function p2wshAddr (coin) { return bitcoin.payments.p2wsh({ hash: Buffer.alloc(32, 0x44), network: net(coin) }).address }

// A UTXO whose txid is a real previous transaction paying `value` at vout 0.
function makeUtxo (coin, kind, value, extra = {}) {
  const network = net(coin)
  const script = kind === 'p2wpkh'
    ? bitcoin.payments.p2wpkh({ pubkey: PUB, network }).output
    : bitcoin.payments.p2pkh({ pubkey: PUB, network }).output
  const tx = new bitcoin.Transaction()
  const seed = Buffer.alloc(32, 0)
  seed.writeUInt32BE(++prevSeq, 0)
  tx.addInput(seed, 0)
  tx.addOutput(script, value)
  PREV.set(tx.getId(), tx.toHex())
  return { txid: tx.getId(), vout: 0, value, confirmations: 6, scriptPubKey: script.toString('hex'), ...extra }
}

function makeEncoder (coin, over = {}) {
  const rates = NETS[coin]
  const encoder = new XChainEncoder(rates.key, '127.0.0.1', '18443', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => (over.est != null ? over.est : rates.est),
    getNetworkInfo: async () => ({ relayfee: over.relay != null ? over.relay : rates.relay }),
    getTransactionHex: async (txid) => {
      if (!PREV.has(txid)) throw new Error('no previous transaction ' + txid)
      return PREV.get(txid)
    },
    getBlockCount: async () => 1000000
  }
  encoder.utxoTrackerConnector = { getUtxosFromAddress: async () => { throw new Error('tracker not stubbed') } }
  return encoder
}

// createTransaction with named arguments.
function create (encoder, a) {
  return encoder.createTransaction(
    a.utxos === undefined ? null : a.utxos, a.pubkey, a.customOutputs || null, a.data, null,
    a.fee == null ? null : a.fee, false, a.encoding == null ? null : a.encoding, a.change == null ? null : a.change,
    a.p2shHash || null, a.p2shHex || null, a.compressedPubKey || null,
    a.unconfirmed === undefined ? true : a.unconfirmed, a.feePerKb == null ? null : a.feePerKb,
    null, a.feeQuote || null, false, false, null)
}

// The unsigned transaction with every input carrying a worst-case signature.
function finalizedTx (psbt) {
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  psbt.data.inputs.forEach((input, i) => {
    if (input.witnessScript) tx.ins[i].witness = [SIG72, PUB, input.witnessScript]
    else if (input.redeemScript) tx.ins[i].script = bitcoin.script.compile([SIG72, PUB, input.redeemScript])
    else if (input.witnessUtxo) tx.ins[i].witness = [SIG72, PUB]
    else tx.ins[i].script = bitcoin.script.compile([SIG72, PUB])
  })
  return tx
}

function inputValue (psbt, i) {
  const input = psbt.data.inputs[i]
  if (input.witnessUtxo) return BigInt(input.witnessUtxo.value)
  return BigInt(bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo).outs[psbt.txInputs[i].index].value)
}

// Inputs, outputs, fee and the broadcast vsize of a built PSBT.
function account (psbt) {
  let ins = 0n
  for (let i = 0; i < psbt.data.inputs.length; i++) ins += inputValue(psbt, i)
  let outs = 0n
  for (const o of psbt.txOutputs) outs += BigInt(o.value)
  const tx = finalizedTx(psbt)
  const fee = ins - outs
  return { ins, outs, fee, vsize: tx.virtualSize(), stripped: tx.byteLength(false), tx }
}

function inputTxids (psbt) {
  return psbt.txInputs.map((i) => Buffer.from(i.hash).reverse().toString('hex'))
}

module.exports = { PUB_HEX, net, p2pkhAddr, p2wpkhAddr, otherAddr, p2wshAddr, makeUtxo, makeEncoder, create, account, inputTxids }
