// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Additional tests targeting the branches in XChainEncoder.js not yet
// covered by the existing test files, specifically:
//   - P2WSH encoding: tx1 (funding), tx2 (spending), segwit-unsupported guard
//   - Non-segwit (P2PKH) UTXO path that calls connector.getTransactionHex
//   - feeQuote injection into customOutputs
//   - payload-too-large guard (MAX_COMPILED_ACTION_DATA_LENGTH)
//   - fee=null/false fast-path vs computed fee increment loop
//   - changeSatoshis ≤ 0 / ≤ dustAmount with no change address (no-throw path)
//   - estimateSpendingP2wshTx() across all three push-size brackets
//   - maxFeeRateKb cap on computed fee rate

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)

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

const DOGE_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('dogecoin-regtest')
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
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)]
    })
  }
  return encoder
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-segwit (legacy P2PKH) UTXO path
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.createTransaction(): non-segwit UTXO path', () => {
  it('calls connector.getTransactionHex for a P2PKH UTXO', async () => {
    const encoder = makeEncoder()
    let hexFetched = false
    encoder.connector.getTransactionHex = async (txid) => {
      hexFetched = true
      assert.strictEqual(txid, TXID_A)
      return RAW_TX_HEX
    }
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.strictEqual(hexFetched, true)
  })

  it('stores the nonWitnessUtxo buffer from the hex for legacy inputs', async () => {
    const encoder = makeEncoder()
    const utxo = makeP2pkhUtxo(TXID_A, 0, 100000000)

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )

    // The PSBT input should have a nonWitnessUtxo buffer (not witnessUtxo)
    const input = result.psbt.data.inputs[0]
    assert.ok(Buffer.isBuffer(input.nonWitnessUtxo), 'should have nonWitnessUtxo buffer')
    assert.ok(!input.witnessUtxo, 'should NOT have witnessUtxo')
  })

  it('uses multiple UTXOs when first is insufficient to cover fee', async () => {
    const encoder = makeEncoder()
    // The oversized explicit fee here exists to force multi-UTXO selection; it
    // would trip the relative fee-rate cap (tested in its own suite), so
    // disable the cap for this test.
    encoder.maxFeeRateMultiplier = null
    // Two P2PKH UTXOs that must be combined. Sorted largest-first:
    // utxo2 (80000) then utxo1 (50000). With a 90000-sat explicit fee (kept
    // under the fixed 100x-fair-fee burn backstop, whose ceiling here is
    // dogecoin-regtest's 100000-koinu dust floor), inputSatoshis after utxo2
    // alone = 80000, which is not > 0 + 90000, so the loop continues and
    // picks up utxo1 too (combined = 130000 > 90000).
    const utxo1 = makeP2pkhUtxo(TXID_A, 0, 50000)
    const utxo2 = makeP2pkhUtxo(TXID_B, 1, 80000)

    const result = await encoder.createTransaction(
      [utxo1, utxo2], TEST_ADDRESS, null,
      'test', null, 90000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )

    // Both UTXOs should be consumed (neither alone covers the fee)
    assert.strictEqual(result.psbt.data.inputs.length, 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P2WSH encoding path (tx1: funding)
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.createTransaction(): P2WSH tx1 (funding)', () => {
  it('throws TypeError when P2WSH is used on a no-segwit network', async () => {
    // dogecoin-regtest has supportsSegwit=false
    const encoder = makeEncoder('dogecoin-regtest')
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, 'P2WSH', TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'TypeError', message: /P2WSH encoding is not supported/ }
    )
  })

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

// ─────────────────────────────────────────────────────────────────────────────
// P2WSH encoding path (tx2: spending)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Payload too large guard
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.createTransaction(): payload size guard', () => {
  it('throws RangeError when compiled payload exceeds MAX_COMPILED_ACTION_DATA_LENGTH (8192)', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
    // A very large data string that will compile to > 8192 bytes
    const hugeData = 'X'.repeat(8200)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        hugeData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /Payload too large/ }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// feeQuote injection
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.createTransaction() - feeQuote injection', () => {
  it('adds feeQuote as an extra output when address and amount > 0', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
    const feeQuote = { address: TEST_ADDRESS, amount: 99000 }

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001,
      null, // dust
      feeQuote
    )

    // Should have OP_RETURN (0) + feeQuote (99000) + change
    const feeQuoteOutput = result.psbt.txOutputs.find(o => o.value === 99000)
    assert.ok(feeQuoteOutput, 'should have a feeQuote output with the correct value')
  })

  it('does not add feeQuote when amount is 0', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
    const feeQuote = { address: TEST_ADDRESS, amount: 0 }

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001,
      null,
      feeQuote
    )

    // Only OP_RETURN (0) + change (no feeQuote output)
    assert.strictEqual(result.psbt.txOutputs.length, 2)
  })

  it('does not add feeQuote when feeQuote has no address', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
    const feeQuote = { amount: 50000 } // no address

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001,
      null,
      feeQuote
    )

    // No feeQuote output; just OP_RETURN + change
    assert.strictEqual(result.psbt.txOutputs.length, 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// maxFeeRateKb cap
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.createTransaction() - maxFeeRateKb cap', () => {
  it('caps the fee rate when connector returns a rate above maxFeeRateKb', async () => {
    // Create encoder with maxFeeRateKb = 1 (sat/kB, very low cap)
    const encoder = new XChainEncoder(
      'dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 1
    )
    encoder.connector = {
      // Return an excessively high fee rate
      getFeePerKilobyte: async () => 1.0, // 1 BTC/kB
      getTransactionHex: async () => RAW_TX_HEX
    }
    encoder.utxoTrackerConnector = {
      getUtxosFromAddress: async () => ({ utxos: [] })
    }

    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, null, false, null, TEST_ADDRESS,
      null, null, null, true, null // null feePerKb → will call connector
    )

    // The fee must be capped; without cap this would consume most of the 1 BTC input
    const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
    const impliedFee = 100000000 - changeOutput.value
    // maxFeeRateKb=1 sat/kB → maxFeePerBytes = 1/1000/100000000 BTC/byte
    // That's tiny (0.00000000001 BTC/byte); floor kicks in at dustAmount
    assert.ok(impliedFee < 100000000 * 0.01,
      `fee ${impliedFee} should be well under 1% of input with cap applied`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Change output edge cases
// ─────────────────────────────────────────────────────────────────────────────

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
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000)
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
    const utxo = makeSegwitUtxo(TXID_A, 0, 150000)
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

// ─────────────────────────────────────────────────────────────────────────────
// Invalid fee
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.createTransaction() - invalid fee', () => {
  it('throws RangeError for a NaN fee string', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 'notanumber', false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /fee must be a non-negative integer/ }
    )
  })

  it('throws RangeError for a negative fee', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, -1, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /fee must be a non-negative integer/ }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// estimateSpendingP2wshTx: all push-size brackets
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.estimateSpendingP2wshTx()', () => {
  const TxSizeEstimator = require('../../src/TxSizeEstimator')
  const MAGIC_WORD = 'XCHN'

  function expectedSize (witnessData) {
    const len = witnessData.length
    const witnessScriptPush = len < 76 ? 1 : len < 256 ? 2 : 3
    const witnessBytes = 2 + 1 + (1 + 72) + (1 + 33) + (witnessScriptPush + len)
    const nonWitnessBytes =
      10
      + (36 + 1 + 4)
      + TxSizeEstimator.estimateOpReturnOutput(
          Buffer.concat([Buffer.from(MAGIC_WORD), Buffer.from('p2wsh')])
        )
    return nonWitnessBytes + Math.ceil(witnessBytes / 4) + 8
  }

  it('uses 1-byte push for witness script < 76 bytes (short bracket)', () => {
    const encoder = makeEncoder()
    const data = Buffer.alloc(50) // < 76 → 1-byte push opcode
    assert.strictEqual(encoder.estimateSpendingP2wshTx(data), expectedSize(data))
  })

  it('uses 2-byte OP_PUSHDATA1 for witness script 76..255 bytes (medium bracket)', () => {
    const encoder = makeEncoder()
    const data = Buffer.alloc(200) // 76 ≤ 200 < 256 → 2-byte push
    assert.strictEqual(encoder.estimateSpendingP2wshTx(data), expectedSize(data))
  })

  it('uses 3-byte OP_PUSHDATA2 for witness script >= 256 bytes (large bracket)', () => {
    const encoder = makeEncoder()
    const data = Buffer.alloc(400) // ≥ 256 → 3-byte push
    assert.strictEqual(encoder.estimateSpendingP2wshTx(data), expectedSize(data))
  })

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

// ─────────────────────────────────────────────────────────────────────────────
// Remaining uncovered branches: customOutputs invalid value, UTXO invalid value,
// unconfirmed=false depletes all UTXOs (line 325), changeSatoshis non-finite
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.createTransaction() - remaining branch coverage', () => {
  it('throws RangeError when customOutputs[i].value is not a valid satoshi amount', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, [{ address: TEST_ADDRESS, value: 'bad' }],
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /customOutputs\[0\].value must be a non-negative integer/ }
    )
  })

  it('throws RangeError when customOutputs[i].value is negative', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    await assert.rejects(
      () => encoder.createTransaction(
        [utxo], TEST_ADDRESS, [{ address: TEST_ADDRESS, value: -1 }],
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /customOutputs\[0\].value must be a non-negative integer/ }
    )
  })

  it('throws RangeError when a UTXO value is not a valid satoshi amount', async () => {
    const encoder = makeEncoder()
    // A UTXO with a NaN value string (parsed inside the UTXO loop)
    const badUtxo = makeSegwitUtxo(TXID_A, 0, 'notanumber')

    await assert.rejects(
      () => encoder.createTransaction(
        [badUtxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      { name: 'RangeError', message: /utxos\[0\].value must be a non-negative integer/ }
    )
  })

  it('throws when unconfirmed=false strips all UTXOs (line 325 path)', async () => {
    const encoder = makeEncoder()
    // All UTXOs have confirmations=0 (mempool), unconfirmed=false strips them all
    const mempoolUtxo = makeSegwitUtxo(TXID_A, 0, 100000000)
    mempoolUtxo.confirmations = 0

    await assert.rejects(
      () => encoder.createTransaction(
        [mempoolUtxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null,
        false, // unconfirmed=false → strips the mempool UTXO
        0.00001
      ),
      /no utxos were provided and no utxos found on the blockchain/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// rawData parameter path
// ─────────────────────────────────────────────────────────────────────────────

describe('XChainEncoder.createTransaction() - rawData parameter', () => {
  it('accepts rawData and includes it in the compiled payload', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
    // rawData is a binary string appended after the text data
    const rawData = '\x01\x02\x03binary content'

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', rawData, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )

    // Should build successfully; the rawData is compiled in via 'binary' encoding
    assert.ok(result.psbt, 'should return a valid PSBT')
    assert.ok(result.encoding, 'should return an encoding')
  })

  it('rawData does not affect result when null (false branch of rawData != null)', async () => {
    const encoder = makeEncoder()
    const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )

    assert.ok(result.psbt)
  })
})
