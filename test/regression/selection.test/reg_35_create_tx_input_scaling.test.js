// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression: a large create_tx held the server's main thread for the whole of
// input selection. bitcoinjs-lib's Psbt.addInput re-checks every input already
// added (re-parsing each witness script), so the cost grew with the square of
// the input count: a 500-input build ran about 2 to 3 s without returning to the
// event loop, and the readiness probe and every other request waited behind it.
// Four such builds in parallel ran back to back on one thread and left the probe
// unanswered past a 10 s client timeout.
//
// Selection now adds each outpoint bare and attaches its fields once selection
// ends, so the cost is linear. Both selection modes are pinned: a caller's exact
// input set and a tracker-fetched set that normal selection walks. Each must
// keep a timer firing through a 500-input build and return the same PSBT bytes
// the quadratic build produced.

const assert = require('assert')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../src/XChainEncoder')
const { getBitcoinJsNetwork } = require('../../../src/build/crypto_networks')

const INPUT_COUNT = 500
const INPUT_VALUE = 20000
// Largest gap between timer ticks the build may cause. A readiness probe with a
// multi-second timeout is safe far below this; the unbroken build blows past it.
const MAX_TICK_GAP_MS = 500
// sha256 of the unsigned PSBTs the quadratic builds produced.
const EXPECTED_EXACT_PSBT_SHA256 = '33271fc914438592f71b410578bfb7da46abbe32f0a81bbcfa94c91f32a85336'
const EXPECTED_TRACKER_PSBT_SHA256 = '6952650583c21c9616dcdea35f59557b5b770bd6837c8360ed7ac8d9eb75b149'
// Pays out all but about eight of the 500 tracker inputs, so selection walks nearly the whole set.
const TRACKER_PAYMENT = 9800000

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
const LTC_REGTEST = getBitcoinJsNetwork('litecoin-regtest')
const CHANGE_ADDRESS = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: LTC_REGTEST }).address
const P2WPKH_SCRIPT = bitcoin.payments.p2wpkh({
  pubkey: pubkeyBuf, network: bitcoin.networks.regtest
}).output.toString('hex')

function makeEncoder () {
  const encoder = new XChainEncoder('litecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async () => { throw new Error('segwit inputs need no previous transaction') }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('exact-input mode must never reach the tracker') }
  }
  return encoder
}

// An encoder whose tracker answers with the given set, as a synced tracker would.
function makeTrackerEncoder (utxos) {
  const encoder = makeEncoder()
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: utxos.map((u) => ({ ...u })),
      sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: true }
    })
  }
  return encoder
}

// Distinct confirmed P2WPKH outpoints, one per txid.
function segwitUtxos (count) {
  const utxos = []
  for (let i = 0; i < count; i++) {
    utxos.push({
      txid: (i + 1).toString(16).padStart(64, '0'),
      vout: i % 4,
      value: INPUT_VALUE,
      confirmations: 6,
      scriptPubKey: P2WPKH_SCRIPT
    })
  }
  return utxos
}

function exactInputBuild (encoder, utxos) {
  return encoder.createTransaction(
    utxos, pubkeyBuf.toString('hex'), [{ address: CHANGE_ADDRESS, value: '100000' }],
    null, null, 100000, false, null, CHANGE_ADDRESS, null, null, null,
    true, null, null, null, false, null, { exactInputs: true })
}

// Runs fn while a 1 ms timer records the longest stretch it could not fire.
async function withTickGap (fn) {
  let last = Date.now()
  let maxGap = 0
  const timer = setInterval(() => {
    const now = Date.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 1)
  try {
    const result = await fn()
    maxGap = Math.max(maxGap, Date.now() - last)
    return { result, maxGap }
  } finally {
    clearInterval(timer)
  }
}

// Normal selection over the tracker's set: the payment needs all but a few of the inputs.
function trackerBuild (encoder) {
  return encoder.createTransaction(
    [], pubkeyBuf.toString('hex'), [{ address: CHANGE_ADDRESS, value: String(TRACKER_PAYMENT) }],
    null, null, null, false, null, CHANGE_ADDRESS, null, null, null, true, null)
}

describe('create_tx adds inputs in linear time on the event loop @regression', function () {
  this.timeout(30000)

  it('keeps a timer firing through a 500-input exact-input build with the same PSBT bytes', async function () {
    const encoder = makeEncoder()
    const { result, maxGap } = await withTickGap(() => exactInputBuild(encoder, segwitUtxos(INPUT_COUNT)))
    assert.strictEqual(result.psbt.txInputs.length, INPUT_COUNT)
    const digest = crypto.createHash('sha256').update(result.psbt.toHex()).digest('hex')
    assert.strictEqual(digest, EXPECTED_EXACT_PSBT_SHA256, 'the linear build must emit the same PSBT bytes')
    assert.ok(maxGap < MAX_TICK_GAP_MS,
      `the build held the event loop ${maxGap} ms without a break (limit ${MAX_TICK_GAP_MS} ms)`)
  })

  it('keeps a timer firing through a tracker-fetched build of nearly 500 inputs with the same PSBT bytes', async function () {
    const encoder = makeTrackerEncoder(segwitUtxos(INPUT_COUNT))
    const { result, maxGap } = await withTickGap(() => trackerBuild(encoder))
    assert.ok(result.psbt.txInputs.length > INPUT_COUNT - 10, `selected ${result.psbt.txInputs.length} inputs`)
    const digest = crypto.createHash('sha256').update(result.psbt.toHex()).digest('hex')
    assert.strictEqual(digest, EXPECTED_TRACKER_PSBT_SHA256, 'the linear build must emit the same PSBT bytes')
    assert.ok(maxGap < MAX_TICK_GAP_MS,
      `the build held the event loop ${maxGap} ms without a break (limit ${MAX_TICK_GAP_MS} ms)`)
  })
})
