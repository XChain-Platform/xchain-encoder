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
const TxSizeEstimator = require('../../../../src/build/tx_size_estimator');
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


const MAGIC_WORD = 'XCHN'

function expectedSize (witnessData) {
  const len = witnessData.length
  // Witness stack items are framed by a compactSize varint (1 byte below 253,
  // 3 bytes through 65535), NOT by script push opcodes. The old mirror here
  // used the 76/256 script-push brackets and so pinned the defect that was
  // fixed in estimateSpendingP2wshTx.
  const witnessScriptPrefix = len < 253 ? 1 : 3
  const witnessBytes = 2 + 1 + (1 + 72) + (1 + 33) + (witnessScriptPrefix + len)
  const nonWitnessBytes =
    10
    + (36 + 1 + 4)
    + TxSizeEstimator.estimateOpReturnOutput(
        Buffer.concat([Buffer.from(MAGIC_WORD), Buffer.from('p2wsh')])
      )
  return nonWitnessBytes + Math.ceil(witnessBytes / 4) + 8
}

describe('XChainEncoder.estimateSpendingP2wshTx()', () => {
  it('uses a 1-byte compactSize prefix for a witness script < 76 bytes', () => {
    const encoder = makeEncoder()
    const data = Buffer.alloc(50) // < 253 → 1-byte varint
    assert.strictEqual(encoder.estimateSpendingP2wshTx(data), expectedSize(data))
  })

  it('uses a 1-byte compactSize prefix for a witness script in 76..252', () => {
    const encoder = makeEncoder()
    const data = Buffer.alloc(200) // still < 253 → 1-byte varint, NOT OP_PUSHDATA1
    assert.strictEqual(encoder.estimateSpendingP2wshTx(data), expectedSize(data))
  })

  it('uses a 3-byte compactSize prefix for a witness script >= 253 bytes', () => {
    const encoder = makeEncoder()
    const data = Buffer.alloc(400) // ≥ 253 → 3-byte varint
    assert.strictEqual(encoder.estimateSpendingP2wshTx(data), expectedSize(data))
  })
})

describe('XChainEncoder.estimateSpendingP2wshTx()', () => {
  // Regression: the mirror above moves with the implementation,
  // so these two cases pin the framing rule independently of it, in the only
  // places where the old script-push model is observable through the ÷4 witness
  // discount. estimateSpendingP2wshTx returns
  //   nonWitness + ceil((110 + prefix + len)/4) + 8,
  // so a one-byte prefix error only survives the ceil when (110 + prefix + len)
  // is a multiple of 4. For the 1-byte varint that is len ≡ 1 (mod 4).
  it('does not add an OP_PUSHDATA1 byte in the 76..252 band (len ≡ 1 mod 4)', () => {
    const encoder = makeEncoder()
    // len 201 and 249: 1-byte varint. The old code charged 2 bytes here, which
    // pushed ceil(witnessBytes/4) up by one and over-funded the reveal output.
    for (const len of [201, 249]) {
      const data = Buffer.alloc(len)
      const withVarint = expectedSize(data)
      const withPushdata1 = withVarint + 1 // what the script-push model produced
      const actual = encoder.estimateSpendingP2wshTx(data)
      assert.strictEqual(actual, withVarint,
        `len=${len}: expected compactSize framing (${withVarint}), got ${actual}`)
      assert.notStrictEqual(actual, withPushdata1,
        `len=${len}: estimate still carries the OP_PUSHDATA1 byte`)
    }
  })

  it('switches prefix width at 253, not at 76 or 256', () => {
    const encoder = makeEncoder()
    // Adding 4 data bytes with no prefix change costs exactly 1 vbyte
    // (4 witness bytes ÷ 4). A prefix change shows up as a departure from that.
    const step = len =>
      encoder.estimateSpendingP2wshTx(Buffer.alloc(len + 4)) -
      encoder.estimateSpendingP2wshTx(Buffer.alloc(len))
    // step(73) spans 73→77 and is the discriminating case: the old script-push
    // model widened at 76 and reported 2 here.
    assert.strictEqual(step(73), 1, 'no prefix change across 76')
    assert.strictEqual(step(252), 2, 'prefix widens 1 to 3 across 253')
    assert.strictEqual(step(256), 1, 'no prefix change across 260')
  })
})

describe('XChainEncoder.estimateSpendingP2wshTx()', () => {
  it('is smaller than estimateSpendingP2shTx for the same data (witness discount)', () => {
    const encoder = makeEncoder()
    const data = Buffer.alloc(200)
    const p2wshSize = encoder.estimateSpendingP2wshTx(data)
    const p2shSize = encoder.estimateSpendingP2shTx(data)
    assert.ok(p2wshSize < p2shSize,
      `P2WSH estimated size (${p2wshSize}) should be less than P2SH (${p2shSize}) for the same data`)
  })

  it('increases monotonically with data size', () => {
    const encoder = makeEncoder()
    const small = encoder.estimateSpendingP2wshTx(Buffer.alloc(50))
    const medium = encoder.estimateSpendingP2wshTx(Buffer.alloc(200))
    const large = encoder.estimateSpendingP2wshTx(Buffer.alloc(400))
    assert.ok(medium > small, 'medium should be larger than small')
    assert.ok(large > medium, 'large should be larger than medium')
  })

  it('includes the 8-byte safety margin in the result', () => {
    // The safety margin is 8 bytes. A 0-byte witness script → minimal estimate.
    // We verify by comparing adjacent data sizes with the known arithmetic.
    const encoder = makeEncoder()
    const data = Buffer.alloc(0)
    const size = encoder.estimateSpendingP2wshTx(data)
    // result = nonWitnessBytes + ceil(witnessBytes/4) + 8
    // verify it equals our reference formula
    assert.strictEqual(size, expectedSize(data))
  })
})
