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

const SATOSHI_UNIT = 100000000

const TXID_PARENT_A = 'a'.repeat(64)
const TXID_PARENT_B = 'b'.repeat(64)
const TXID_SHARED   = 'c'.repeat(64)

const pubkeyBuf = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
const DOGE_REGTEST = require('../../../../src/build/crypto_networks').getBitcoinJsNetwork('dogecoin-regtest')
const TEST_ADDRESS = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: DOGE_REGTEST }).address
const INPUT_VALUE = 100000000            // 1 DOGE in koinu
const NODE_RATE_PER_KB = 0.01            // Dogecoin's block-inclusion floor
const TARGET_PER_BYTE = NODE_RATE_PER_KB * SATOSHI_UNIT / 1000   // 1000 koinu/byte


// P2PKH, the only output type a chain without segwit holds, so these fixtures
// describe a UTXO the chain under test could actually produce.
const P2PKH_SCRIPT = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest }).output

function makeUtxo (txid, confirmations) {
  return {
    txid,
    vout: 0,
    value: INPUT_VALUE,
    confirmations,
    scriptPubKey: P2PKH_SCRIPT.toString('hex')
  }
}

// The whole previous transaction, which a legacy input carries as nonWitnessUtxo.
function prevTxHex () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  tx.addOutput(P2PKH_SCRIPT, INPUT_VALUE)
  return tx.toHex()
}

function makeEncoder (ancestorPackage) {
  const encoder = new XChainEncoder('dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => NODE_RATE_PER_KB,
    getTransactionHex: async () => prevTxHex(),
    // The suggested-rate ceiling on a test chain reads the node's relay floor;
    // without it the build would clamp to the 20-per-vByte Bitcoin-scale default
    // and never price a DOGE package at all.
    getNetworkInfo: async () => ({ relayfee: 0.001 }),
    getUnconfirmedAncestorPackage: async (txids) => {
      encoder.connector.askedFor = txids
      return typeof ancestorPackage === 'function' ? ancestorPackage(txids) : ancestorPackage
    }
  }
  // The chain dust floor sits above the fees these probes produce; the floor has
  // its own suite, so lower it here to keep the sizing behaviour observable.
  encoder.dustAmount = 546
  return encoder
}

async function create (encoder, utxos) {
  // Every probe here respends the same fixture input on one encoder to
  // compare fees, so release the previous build's reservation first.
  encoder.clearReservations()
  return encoder.createTransaction(
    utxos, TEST_ADDRESS, null, 'test', null, null, false, null, TEST_ADDRESS,
    null, null, null, true, null
  )
}

// inputs − all outputs = the fee actually embedded in the PSBT
function paidFee (result) {
  const outputs = result.psbt.txOutputs.reduce((sum, o) => sum + o.value, 0)
  return INPUT_VALUE - outputs
}

// The node rate is exactly 1000 koinu/byte, so the unpackaged fee IS the
// estimated size in bytes × 1000. Recovering the size this way keeps the
// assertions below independent of the estimator's exact byte count.
async function baselineFee (encoder) {
  return paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 6)]))
}

describe('XChainEncoder package-aware fee sizing @regression @tier1', () => {

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  it('leaves the fee untouched when every input is confirmed, and never asks the node', async () => {
    const encoder = makeEncoder({ size: 5000, fees: 0.001 })
    const fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 6)]))
    assert.strictEqual(encoder.connector.askedFor, undefined, 'no ancestor lookup for a confirmed selection')
    assert.ok(fee > 0 && fee % 1000 === 0, 'the fee is the per-transaction fee, got ' + fee)
  })

  it('lifts the fee so a cheap ancestor package clears the target rate', async () => {
    // The live shape: 2000 bytes of ancestors paying 0.00313 DOGE/kB against a
    // 0.01 DOGE/kB target.
    const ancestorSize = 2000
    const ancestorFees = 0.00626
    const encoder = makeEncoder({ size: ancestorSize, fees: ancestorFees })
    const baseline = await baselineFee(encoder)
    const txSize = baseline / 1000

    const fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 0)]))
    assert.deepStrictEqual(encoder.connector.askedFor, [TXID_PARENT_A])
    assert.ok(fee > baseline, `fee ${fee} must exceed the per-transaction fee ${baseline}`)

    const packageRate = (ancestorFees * SATOSHI_UNIT + fee) / (ancestorSize + txSize)
    assert.ok(packageRate >= TARGET_PER_BYTE,
      `package rate ${packageRate} koinu/byte must reach the ${TARGET_PER_BYTE} target`)
    // And no further than it needs to go.
    assert.ok(packageRate < TARGET_PER_BYTE * 1.01, 'the uplift must not overpay, got ' + packageRate)
  })

  it('does not lower the fee when the ancestors already pay well above the target', async () => {
    const encoder = makeEncoder({ size: 2000, fees: 1 })   // 1 DOGE over 2000 bytes
    const baseline = await baselineFee(encoder)
    const fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 0)]))
    assert.strictEqual(fee, baseline, 'a rich package must leave this fee exactly as it was')
  })

  it('counts a shared ancestor once by handing the node every unconfirmed input txid', async () => {
    const encoder = makeEncoder({ size: 2000, fees: 0.00626 })
    // Two unconfirmed inputs, one confirmed: only the unconfirmed pair is asked
    // about, and the connector is what dedupes the ancestors they share.
    const utxos = [makeUtxo(TXID_PARENT_A, 0), makeUtxo(TXID_PARENT_B, 0), makeUtxo(TXID_SHARED, 6)]
    utxos[1].vout = 1
    utxos[2].vout = 2
    // A tiny value on the later inputs so selection takes the big one first and
    // still walks the rest of the set.
    utxos[1].value = 1
    utxos[2].value = 1
    await create(encoder, utxos)
    assert.deepStrictEqual(encoder.connector.askedFor, [TXID_PARENT_A],
      'selection stops once the inputs cover outputs plus fee, so only what it took is asked about')
  })

})

describe('XChainEncoder package-aware fee sizing @regression @tier1', () => {

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  it('falls back to the per-transaction fee when the ancestor lookup fails', async () => {
    const encoder = makeEncoder(null)      // the connector could not price the package
    const baseline = await baselineFee(encoder)
    const fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 0)]))
    assert.strictEqual(fee, baseline)
  })

  it('never throws when the ancestor lookup itself throws', async () => {
    const encoder = makeEncoder(() => { throw new Error('node RPC exploded') })
    const baseline = await baselineFee(encoder)
    const fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 0)]))
    assert.strictEqual(fee, baseline, 'a thrown lookup degrades to the per-transaction fee')
  })

  it('degrades when the connector has no package method at all', async () => {
    const encoder = makeEncoder({ size: 2000, fees: 0 })
    delete encoder.connector.getUnconfirmedAncestorPackage
    const fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 0)]))
    assert.ok(fee > 0 && fee % 1000 === 0, 'the fee is the per-transaction fee, got ' + fee)
  })

})

describe('XChainEncoder package-aware fee sizing @regression @tier1', () => {

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  it('clamps the uplift at MAX_CPFP_UPLIFT_SAT and warns that the package stays under target', async () => {
    const ancestorSize = 2000
    const ancestorFees = 0.00626
    const encoder = makeEncoder({ size: ancestorSize, fees: ancestorFees })
    const baseline = await baselineFee(encoder)
    const txSize = baseline / 1000

    process.env.MAX_CPFP_UPLIFT_SAT = '100000'
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    let fee
    try {
      fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 0)]))
    } finally {
      console.warn = originalWarn
    }

    assert.strictEqual(fee, baseline + 100000, 'the uplift is bounded at exactly the configured maximum')
    const packageRate = (ancestorFees * SATOSHI_UNIT + fee) / (ancestorSize + txSize)
    assert.ok(packageRate < TARGET_PER_BYTE, 'this is the clamped, still-under-target case')
    assert.ok(warnings.some(w => /Package fee uplift clamped/.test(w) && /MAX_CPFP_UPLIFT_SAT/.test(w)),
      'the operator must be told the package will stay under target: ' + warnings.join(' | '))
  })

  it('MAX_CPFP_UPLIFT_SAT=0 turns package sizing off entirely', async () => {
    const encoder = makeEncoder({ size: 2000, fees: 0 })
    const baseline = await baselineFee(encoder)
    process.env.MAX_CPFP_UPLIFT_SAT = '0'
    const fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 0)]))
    assert.strictEqual(fee, baseline)
    assert.strictEqual(encoder.connector.askedFor, undefined, 'a disabled uplift costs no RPC round trip')
  })

})

describe('XChainEncoder package-aware fee sizing @regression @tier1', () => {

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  it('clamps the uplift to the fee-rate cap rather than blowing through it', async () => {
    // MAX_FEE_RATE_KB of 2x the node rate leaves only 1x the per-transaction fee
    // of headroom, far less than a 2000-byte cheap package asks for.
    const encoder = new XChainEncoder('dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '',
      NODE_RATE_PER_KB * SATOSHI_UNIT * 2)
    encoder.connector = {
      getFeePerKilobyte: async () => NODE_RATE_PER_KB,
      // The suggested-rate ceiling on a test chain reads the node's relay floor;
      // without it the build would clamp to the 20-per-vByte Bitcoin-scale default
      // and never price a DOGE package at all.
      getNetworkInfo: async () => ({ relayfee: 0.001 }),
      getTransactionHex: async () => prevTxHex(),
      getUnconfirmedAncestorPackage: async () => ({ size: 2000, fees: 0 })
    }
    encoder.dustAmount = 546
    const baseline = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 6)]))
    const fee = paidFee(await create(encoder, [makeUtxo(TXID_PARENT_A, 0)]))
    assert.ok(fee > baseline, 'the uplift still applies up to the cap')
    // The cap ceiling rounds a float rate up, so allow the one base unit that
    // costs; the point is that it stops there and not at the package rate.
    assert.ok(fee >= baseline * 2 && fee <= baseline * 2 + 1,
      `fee ${fee} must stop at the capped rate (~${baseline * 2}) for this size`)
  })

  it('never spends more than the inputs hold', async () => {
    // A 2000-byte free package wants ~2,000,000 koinu of uplift; this input
    // cannot cover it, and the build must still produce a signable PSBT rather
    // than fail with INSUFFICIENT_FUNDS.
    const encoder = makeEncoder({ size: 2000, fees: 0 })
    const utxo = makeUtxo(TXID_PARENT_A, 0)
    utxo.value = 400000
    const result = await encoder.createTransaction(
      [utxo], TEST_ADDRESS, null, 'test', null, null, false, null, TEST_ADDRESS,
      null, null, null, true, null
    )
    const outputs = result.psbt.txOutputs.reduce((sum, o) => sum + o.value, 0)
    assert.ok(outputs <= 400000, 'the transaction may never pay out more than it takes in')
  })

})

