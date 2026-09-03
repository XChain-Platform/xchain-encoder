// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// CPFP-aware package fee sizing.
//
// A miner fills a block by ANCESTOR fee rate, so a transaction that spends
// unconfirmed inputs is mined on the rate of its whole mempool package, not on
// its own. The live failure: a PRICE batch paid 0.01017 DOGE/kB standalone,
// above Dogecoin's 0.01 DOGE/kB inclusion floor, but its funding ancestors pay
// 0.00313 DOGE/kB, which drags the package to 0.00896 and leaves it unmined.
// The inputs do not signal RBF, so the fee cannot be raised afterwards; it has
// to be right when the transaction is built.

const assert = require('assert')
const axios = require('axios')
const bitcoin = require('bitcoinjs-lib')
const BlockchainConnector = require('../../src/BlockchainConnector')
const XChainEncoder = require('../../src/XChainEncoder')

const SATOSHI_UNIT = 100000000

const TXID_PARENT_A = 'a'.repeat(64)
const TXID_PARENT_B = 'b'.repeat(64)
const TXID_SHARED   = 'c'.repeat(64)
const TXID_GRANDPA  = 'd'.repeat(64)

let originalPost
beforeEach(() => { originalPost = axios.post })
afterEach(() => { axios.post = originalPost })

function makeConnector () {
  return new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
}

// A Core 0.14 / Dogecoin 1.14 mempool entry: flat `size` and `fee` fields.
function entry (size, fee) {
  return { size, fee, time: 0, height: 1 }
}

// A node that answers getmempoolentry and getmempoolancestors from `mempool`
// (txid -> {entry, ancestors:[txid]}). Anything absent answers RPC -5, exactly
// as a node does for an already-confirmed transaction.
function stubMempool (mempool, onCall) {
  axios.post = async (url, data) => {
    if (onCall) onCall(data)
    const txid = data.params && data.params[0]
    const node = mempool[txid]
    if (!node) {
      return { data: { error: { code: -5, message: 'Transaction not in mempool' } } }
    }
    if (data.method === 'getmempoolentry') return { data: { result: node.entry } }
    if (data.method === 'getmempoolancestors') {
      const result = {}
      for (const ancestor of (node.ancestors || [])) result[ancestor] = mempool[ancestor].entry
      return { data: { result } }
    }
    return { data: { result: {} } }
  }
}

describe('BlockchainConnector.getUnconfirmedAncestorPackage() @regression @tier1', () => {

  it('sums an unconfirmed parent and everything above it', async () => {
    stubMempool({
      [TXID_PARENT_A]: { entry: entry(400, 0.001), ancestors: [TXID_GRANDPA] },
      [TXID_GRANDPA]:  { entry: entry(600, 0.002), ancestors: [] }
    })
    const pkg = await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A])
    assert.strictEqual(pkg.size, 1000)
    assert.ok(Math.abs(pkg.fees - 0.003) < 1e-12, 'fees are summed in coin units, got ' + pkg.fees)
  })

  it('counts a shared ancestor once when two inputs both descend from it', async () => {
    // Both selected inputs hang off TXID_SHARED. Counting it twice would inflate
    // the package by its size and its fee, and the child would overpay.
    stubMempool({
      [TXID_PARENT_A]: { entry: entry(400, 0.001), ancestors: [TXID_SHARED] },
      [TXID_PARENT_B]: { entry: entry(300, 0.001), ancestors: [TXID_SHARED] },
      [TXID_SHARED]:   { entry: entry(500, 0.005), ancestors: [] }
    })
    const pkg = await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A, TXID_PARENT_B])
    assert.strictEqual(pkg.size, 1200, '400 + 300 + 500, the shared ancestor once')
    assert.ok(Math.abs(pkg.fees - 0.007) < 1e-12, 'got ' + pkg.fees)
  })

  it('dedupes repeated input txids before it asks the node', async () => {
    const asked = []
    stubMempool({
      [TXID_PARENT_A]: { entry: entry(400, 0.001), ancestors: [] }
    }, (data) => asked.push(data.method))
    const pkg = await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A, TXID_PARENT_A])
    assert.strictEqual(pkg.size, 400)
    assert.strictEqual(asked.length, 2, 'one getmempoolentry and one getmempoolancestors, not four')
  })

  it('skips a txid the mempool does not hold (already confirmed)', async () => {
    stubMempool({
      [TXID_PARENT_A]: { entry: entry(400, 0.001), ancestors: [] }
    })
    const pkg = await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A, TXID_PARENT_B])
    assert.strictEqual(pkg.size, 400, 'the confirmed parent contributes nothing')
  })

  it('returns an empty package when every input is already confirmed', async () => {
    stubMempool({})
    const pkg = await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A])
    assert.deepStrictEqual(pkg, { size: 0, fees: 0 })
  })

  it('returns an empty package for an empty or non-array input', async () => {
    const c = makeConnector()
    assert.deepStrictEqual(await c.getUnconfirmedAncestorPackage([]), { size: 0, fees: 0 })
    assert.deepStrictEqual(await c.getUnconfirmedAncestorPackage(null), { size: 0, fees: 0 })
  })

  it('reads the modern Core field layout (vsize and fees.base)', async () => {
    stubMempool({
      [TXID_PARENT_A]: { entry: { vsize: 250, fees: { base: 0.00005 } }, ancestors: [] }
    })
    const pkg = await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A])
    assert.strictEqual(pkg.size, 250)
    assert.ok(Math.abs(pkg.fees - 0.00005) < 1e-12)
  })

  it('returns null on an RPC error rather than throwing', async () => {
    axios.post = async () => ({ data: { error: { code: -32601, message: 'Method not found' } } })
    assert.strictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
  })

  it('returns null when the node is unreachable', async () => {
    axios.post = async () => { throw new Error('ECONNREFUSED') }
    assert.strictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
  })

  it('returns null on an HTTP-500 RPC error body', async () => {
    axios.post = async () => {
      const err = new Error('Request failed with status code 500')
      err.response = { data: { error: { code: -8, message: 'Invalid parameter' } } }
      throw err
    }
    assert.strictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
  })

  it('returns null when an entry carries no readable size or fee', async () => {
    // Undercounting an ancestor is worse than not sizing the package at all: it
    // produces a confident uplift that still leaves the package under target.
    stubMempool({
      [TXID_PARENT_A]: { entry: { time: 0 }, ancestors: [] }
    })
    assert.strictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
  })

  it('does not leak the RPC password when a mempool call fails', async () => {
    const util = require('util')
    const FAKE_RPC_PASSWORD = 'FAKEPASS_must_never_be_logged_4b1e'
    const err = new Error('Request failed with status code 401')
    err.config = { auth: { username: 'rpcuser', password: FAKE_RPC_PASSWORD } }
    axios.post = async () => { throw err }

    const logs = []
    const originalWarn = console.warn
    console.warn = (...args) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 8 }))).join(' '))
    }
    try {
      const c = new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', FAKE_RPC_PASSWORD)
      assert.strictEqual(await c.getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
    } finally {
      console.warn = originalWarn
    }
    assert.ok(!logs.join('\n').includes(FAKE_RPC_PASSWORD), 'the RPC password must never be logged')
  })
})

describe('packageFeeUpliftSatoshis() @regression @tier1', () => {
  const uplift = (o) => XChainEncoder.packageFeeUpliftSatoshis(Object.assign({ satoshiUnit: SATOSHI_UNIT }, o))

  it('reproduces the live DOGE shortfall', () => {
    // 2000 bytes of ancestors paying 0.00313 DOGE/kB, a 1000-byte child, a
    // 0.01 DOGE/kB target: the package needs 0.03 DOGE and the ancestors bring
    // 0.00626, so the child owes 0.02374 DOGE (2,374,000 koinu).
    const owed = uplift({
      currentFee: 0,
      txSize: 1000,
      ancestorSize: 2000,
      ancestorFees: 0.00626,
      targetFeePerBytes: 0.01 / 1000
    })
    assert.strictEqual(owed, 2374000)
    const packageRate = (626000 + owed) / 3000 * 1000 / SATOSHI_UNIT
    assert.ok(packageRate >= 0.01, 'the uplifted package must clear the inclusion floor, got ' + packageRate)
  })

  it('subtracts what the transaction already pays', () => {
    const owed = uplift({
      currentFee: 1000000,
      txSize: 1000,
      ancestorSize: 2000,
      ancestorFees: 0.00626,
      targetFeePerBytes: 0.01 / 1000
    })
    assert.strictEqual(owed, 1374000)
  })

  it('returns 0 when the package already clears the target', () => {
    assert.strictEqual(uplift({
      currentFee: 500000,
      txSize: 250,
      ancestorSize: 500,
      ancestorFees: 0.05,
      targetFeePerBytes: 0.01 / 1000
    }), 0, 'a rich ancestor must never LOWER this fee')
  })

  it('returns 0 for an empty package or a missing target', () => {
    const base = { currentFee: 0, txSize: 250, ancestorSize: 0, ancestorFees: 0, targetFeePerBytes: 0.00001 }
    assert.strictEqual(uplift(base), 0)
    assert.strictEqual(uplift(Object.assign({}, base, { ancestorSize: 1000, targetFeePerBytes: 0 })), 0)
    assert.strictEqual(uplift(Object.assign({}, base, { ancestorSize: 1000, txSize: 0 })), 0)
    assert.strictEqual(uplift(Object.assign({}, base, { ancestorSize: NaN })), 0)
  })
})

describe('XChainEncoder package-aware fee sizing @regression @tier1', () => {
  const pubkeyBuf = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
  const DOGE_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('dogecoin-regtest')
  const TEST_ADDRESS = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: DOGE_REGTEST }).address
  const INPUT_VALUE = 100000000            // 1 DOGE in koinu
  const NODE_RATE_PER_KB = 0.01            // Dogecoin's block-inclusion floor
  const TARGET_PER_BYTE = NODE_RATE_PER_KB * SATOSHI_UNIT / 1000   // 1000 koinu/byte

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  function makeUtxo (txid, confirmations) {
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest })
    return {
      txid,
      vout: 0,
      value: INPUT_VALUE,
      confirmations,
      scriptPubKey: p2wpkh.output.toString('hex')
    }
  }

  function makeEncoder (ancestorPackage) {
    const encoder = new XChainEncoder('dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
    encoder.connector = {
      getFeePerKilobyte: async () => NODE_RATE_PER_KB,
      // The suggested-rate ceiling on a test chain reads the node's relay floor;
      // without it the build would clamp to the 20-per-vByte Bitcoin-scale default
      // and never price a DOGE package at all.
      getNetworkInfo: async () => ({ relayfee: 0.001 }),
      getUnconfirmedAncestorPackage: async (txids) => {
        encoder.connector.askedFor = txids
        return typeof ancestorPackage === 'function' ? ancestorPackage(txids) : ancestorPackage
      }
    }
    // dogecoin-regtest's 100000-koinu dust floor sits above the fees these
    // probes produce; the floor has its own suite, so lower it here to keep the
    // sizing behaviour under test observable.
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
