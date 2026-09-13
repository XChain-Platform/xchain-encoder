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

  // Number(null), Number('') and Number(false) are all a finite 0, so a bare
  // Number() cast priced an unreadable fee field as a genuine zero-fee ancestor
  // and the package was uplifted against an understated total. An unreadable
  // field has to invalidate the package, exactly as the contract above says.
  for (const [label, fee] of [['null', null], ['an empty string', ''], ['false', false]]) {
    it(`returns null when the flat fee field is ${label}`, async () => {
      stubMempool({
        [TXID_PARENT_A]: { entry: { size: 400, fee }, ancestors: [] }
      })
      assert.strictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
    })
  }

  it('returns null when the nested fees.base field is null', async () => {
    stubMempool({
      [TXID_PARENT_A]: { entry: { vsize: 400, fees: { base: null } }, ancestors: [] }
    })
    assert.strictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
  })

  it('still prices a legitimate zero-fee ancestor, in both field layouts', async () => {
    stubMempool({
      [TXID_PARENT_A]: { entry: { size: 400, fee: 0 }, ancestors: [] }
    })
    assert.deepStrictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), { size: 400, fees: 0 })
    stubMempool({
      [TXID_PARENT_B]: { entry: { vsize: 250, fees: { base: 0 } }, ancestors: [] }
    })
    assert.deepStrictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_B]), { size: 250, fees: 0 })
  })

  it('returns null when the size field is a boolean rather than a number', async () => {
    // Number(true) is 1, which used to be accepted as a one-byte ancestor.
    stubMempool({
      [TXID_PARENT_A]: { entry: { vsize: true, fee: 0.001 }, ancestors: [] }
    })
    assert.strictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
  })

  // getmempoolentry and getmempoolancestors are two independent round trips, so
  // a block can confirm the root between them; the node then answers the second
  // call with -5. The root's bytes and fee must not survive that: paying to
  // accelerate an already-mined parent is real coin spent on nothing.
  it('discards a root that confirms between its two RPC calls', async () => {
    const mempool = {
      [TXID_PARENT_A]: { entry: entry(400, 0.001), ancestors: [TXID_GRANDPA] },
      [TXID_GRANDPA]: { entry: entry(300, 0.0005), ancestors: [] }
    }
    stubMempool(mempool, (data) => {
      if (data.method === 'getmempoolancestors' && data.params[0] === TXID_PARENT_A) {
        delete mempool[TXID_PARENT_A]
      }
    })
    const pkg = await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A])
    assert.deepStrictEqual(pkg, { size: 0, fees: 0 })
  })

  it('keeps an earlier root\'s branch when a later root confirms mid-sequence', async () => {
    const mempool = {
      [TXID_PARENT_A]: { entry: entry(400, 0.001), ancestors: [TXID_SHARED] },
      [TXID_PARENT_B]: { entry: entry(500, 0.002), ancestors: [TXID_SHARED] },
      [TXID_SHARED]: { entry: entry(200, 0.0004), ancestors: [] }
    }
    stubMempool(mempool, (data) => {
      if (data.method === 'getmempoolancestors' && data.params[0] === TXID_PARENT_B) {
        delete mempool[TXID_PARENT_B]
      }
    })
    const pkg = await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A, TXID_PARENT_B])
    assert.strictEqual(pkg.size, 600, 'parent A plus the shared ancestor it validly committed')
    assert.ok(Math.abs(pkg.fees - 0.0014) < 1e-12, 'got ' + pkg.fees)
  })

  it('returns null when the second call fails for a reason other than absence', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getmempoolentry') return { data: { result: entry(400, 0.001) } }
      return { data: { error: { code: -32603, message: 'Internal error' } } }
    }
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

  it('takes the ancestor fee in base units when one is given, ahead of the coin-unit figure', () => {
    // The two-phase prefund knows the commit's fee exactly, as an integer. A
    // coin-unit round trip would reintroduce the float error the ceiling shaves.
    const owed = uplift({
      currentFee: 0,
      txSize: 1000,
      ancestorSize: 2000,
      ancestorFees: 1,                  // a wildly different coin-unit figure
      ancestorFeeSatoshis: 626000,
      targetFeePerBytes: 0.01 / 1000
    })
    assert.strictEqual(owed, 2374000, 'the base-unit figure wins')
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

// A reveal spends nothing but the commit's own outputs, so the pair is
// always one mempool package and a miner weighs them together. The reveal's fee
// is money the commit set aside and the reveal has no second input to raise it
// from, so a commit that lands under the target rate drags the package under it
// and nothing downstream can fix that: the pair sits unmined behind a confirmed
// commit. These pin that the commit prefunds the reveal at the PACKAGE rate, and
// that the P2SH reveal keeps that money as fee instead of sweeping it home.
describe('two-phase reveal package prefund @regression @tier1', () => {
  const ecc = require('tiny-secp256k1')
  const { ECPairFactory } = require('ecpair')
  bitcoin.initEccLib(ecc)
  const KEY = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 7))
  const PUBKEY_HEX = Buffer.from(KEY.publicKey).toString('hex')

  const BTC_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('bitcoin-regtest')
  const BTC_RATE_KB = 0.0001                                  // 10 sat/byte
  const BTC_TARGET_PER_BYTE = BTC_RATE_KB * SATOSHI_UNIT / 1000
  const COMMIT_INPUT_VALUE = 100000000
  // Far under the target rate for a commit of any size: the congestion-clamped
  // commit the ledger entry describes, reproduced as an explicit caller fee.
  const UNDER_TARGET_COMMIT_FEE = 700
  const ENVELOPE_PAYLOAD = 'x'.repeat(20000)

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  function envelopeEncoder (ancestorPackage) {
    const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
    encoder.connector = {
      getFeePerKilobyte: async () => BTC_RATE_KB,
      // Without a relayfee the suggested-rate ceiling clamps to its default and
      // the probe rate below would never be priced at all.
      getNetworkInfo: async () => ({ relayfee: 0.00001 }),
      getTransactionHex: async () => { throw new Error('unit test: no node') }
    }
    if (ancestorPackage !== undefined) {
      encoder.connector.getUnconfirmedAncestorPackage = async () =>
        (typeof ancestorPackage === 'function' ? ancestorPackage() : ancestorPackage)
    }
    return encoder
  }

  function callerAddress () {
    return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network: BTC_REGTEST }).address
  }

  function segwitUtxo (value, confirmations) {
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network: BTC_REGTEST })
    return { txid: TXID_PARENT_A, vout: 0, value, confirmations, scriptPubKey: p2wpkh.output.toString('hex') }
  }

  async function buildEnvelope (encoder, { commitFee = null, inputValue = COMMIT_INPUT_VALUE, confirmations = 6 } = {}) {
    encoder.clearReservations()
    const addr = callerAddress()
    return encoder.createTransaction(
      [segwitUtxo(inputValue, confirmations)], addr, null, 'FILE|0|package-prefund',
      ENVELOPE_PAYLOAD, commitFee, false, 'TAPROOT', addr, null, null, PUBKEY_HEX)
  }

  function unsignedTx (psbt) {
    return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  }

  // Sign both halves so the package is measured on the bytes a miner actually
  // sees, not on the builder's own estimate of them.
  function signedPair (result) {
    const signer = {
      publicKey: Buffer.from(KEY.publicKey),
      sign: (h) => Buffer.from(KEY.sign(h)),
      signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, KEY.privateKey))
    }
    const commitPsbt = bitcoin.Psbt.fromHex(result.psbt.toHex())
    commitPsbt.signAllInputs(signer)
    commitPsbt.finalizeAllInputs()
    const commitTx = commitPsbt.extractTransaction()

    const revealPsbt = result.revealPsbt
    revealPsbt.signInput(0, signer)
    revealPsbt.finalizeAllInputs()
    const revealTx = revealPsbt.extractTransaction()
    return { commitTx, revealTx }
  }

  it('lifts the prefund so a commit paying under the target rate still clears it as a package', async () => {
    const result = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })
    const { commitTx, revealTx } = signedPair(result)

    const commitFee = COMMIT_INPUT_VALUE - commitTx.outs.reduce((s, o) => s + o.value, 0)
    assert.strictEqual(commitFee, UNDER_TARGET_COMMIT_FEE, 'the commit still pays exactly what the caller asked')
    assert.ok(commitFee / commitTx.virtualSize() < BTC_TARGET_PER_BYTE,
      'this probe is only meaningful while the commit itself is under target')

    const revealFee = commitTx.outs[result.envelope.commitVout].value -
      revealTx.outs.reduce((s, o) => s + o.value, 0)
    const packageRate = (commitFee + revealFee) / (commitTx.virtualSize() + revealTx.virtualSize())
    assert.ok(packageRate >= BTC_TARGET_PER_BYTE,
      `commit+reveal package pays ${packageRate} sat/byte, under the ${BTC_TARGET_PER_BYTE} target`)
  })

  it('leaves the reveal its change output rather than paying the uplift out of it', async () => {
    const encoder = envelopeEncoder()
    const result = await buildEnvelope(encoder, { commitFee: UNDER_TARGET_COMMIT_FEE })
    // commitValue = revealFee + dust by construction; both move together or the
    // uplift silently returns to the caller as change instead of reaching miners.
    assert.strictEqual(result.envelope.commitValue, result.envelope.revealFee + encoder.dustAmount)
    assert.strictEqual(Number(result.revealPsbt.txOutputs[0].value), encoder.dustAmount,
      'the reveal still leaves exactly one dust output back to the caller')
    const commitTx = unsignedTx(result.psbt)
    assert.strictEqual(commitTx.outs[result.envelope.commitVout].value, result.envelope.commitValue,
      'the commit output on the wire carries the raised value')
  })

  it('adds nothing when the commit already pays the target rate on its own bytes', async () => {
    // Same build, node-derived fee: the commit pays the target, so the package
    // already clears it and the prefund must not grow by a single satoshi.
    const withPackaging = await buildEnvelope(envelopeEncoder())
    process.env.MAX_CPFP_UPLIFT_SAT = '0'
    const withoutPackaging = await buildEnvelope(envelopeEncoder())
    assert.strictEqual(withPackaging.envelope.revealFee, withoutPackaging.envelope.revealFee,
      'a commit at target must not buy the reveal a bigger prefund')
  })

  it('carries ancestors the commit\'s own capped uplift could not pay for', async () => {
    // A commit whose CPFP uplift is capped at the node rate cannot pay for the
    // free ancestors it spends: the rate cap measures a fee against the commit's
    // OWN bytes, so there is no room in it for anyone else's. The reveal is the
    // only half of the package left that can still be raised, and its prefund is
    // bought with change rather than with commit fee, so the cap does not bind it.
    const capped = (ancestorPackage) => {
      const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '',
        BTC_RATE_KB * SATOSHI_UNIT)
      encoder.connector = {
        getFeePerKilobyte: async () => BTC_RATE_KB,
        getNetworkInfo: async () => ({ relayfee: 0.00001 }),
        getTransactionHex: async () => { throw new Error('unit test: no node') },
        getUnconfirmedAncestorPackage: async () => ancestorPackage
      }
      return encoder
    }
    const originalWarn = console.warn
    console.warn = () => {}
    let withAncestors, withoutAncestors
    try {
      withAncestors = await buildEnvelope(capped({ size: 2000, fees: 0 }), { confirmations: 0 })
      withoutAncestors = await buildEnvelope(capped({ size: 0, fees: 0 }), { confirmations: 0 })
    } finally {
      console.warn = originalWarn
    }
    assert.ok(withAncestors.envelope.revealFee > withoutAncestors.envelope.revealFee,
      `unpaid ancestors must raise the prefund (${withAncestors.envelope.revealFee} vs ${withoutAncestors.envelope.revealFee})`)
    // 2000 free ancestor bytes at the 10 sat/byte target is what is owed, give or
    // take the single base unit the rate's float representation costs.
    const owed = withAncestors.envelope.revealFee - withoutAncestors.envelope.revealFee
    assert.ok(Math.abs(owed - 2000 * BTC_TARGET_PER_BYTE) <= 1,
      `owed ${owed} against ${2000 * BTC_TARGET_PER_BYTE} for the unpaid ancestor bytes`)
  })

  it('MAX_CPFP_UPLIFT_SAT=0 turns the prefund off entirely', async () => {
    const baseline = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })
    process.env.MAX_CPFP_UPLIFT_SAT = '0'
    const disabled = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })
    assert.ok(baseline.envelope.revealFee > disabled.envelope.revealFee,
      'the probe must actually be lifting something when sizing is on')
  })

  it('clamps at MAX_CPFP_UPLIFT_SAT and warns that the package stays under target', async () => {
    process.env.MAX_CPFP_UPLIFT_SAT = '0'
    const disabled = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })

    process.env.MAX_CPFP_UPLIFT_SAT = '11'
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    let clamped
    try {
      clamped = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })
    } finally {
      console.warn = originalWarn
    }
    assert.strictEqual(clamped.envelope.revealFee, disabled.envelope.revealFee + 11,
      'the prefund stops at exactly the configured bound')
    assert.ok(warnings.some(w => /Reveal package prefund clamped/.test(w) && /MAX_CPFP_UPLIFT_SAT/.test(w)),
      'the operator must be told the package will stay under target: ' + warnings.join(' | '))
  })

  it('never prefunds more than the commit inputs hold', async () => {
    // The input barely covers the commit's own outputs and fee. The build must
    // still produce a signable pair rather than fail with INSUFFICIENT_FUNDS.
    const encoder = envelopeEncoder({ size: 500000, fees: 0 })
    const result = await buildEnvelope(encoder, { commitFee: UNDER_TARGET_COMMIT_FEE, inputValue: 53000, confirmations: 0 })
    const commitTx = unsignedTx(result.psbt)
    const outputs = commitTx.outs.reduce((s, o) => s + o.value, 0)
    assert.ok(outputs + UNDER_TARGET_COMMIT_FEE <= 53000,
      `commit pays out ${outputs} + ${UNDER_TARGET_COMMIT_FEE} fee against a ${53000} input`)
    assert.strictEqual(result.envelope.commitValue, commitTx.outs[result.envelope.commitVout].value)
  })
})

// The P2SH lane splits the two phases across two calls, so the commit funds the
// package rate into its first leg and the reveal has to KEEP that money as fee
// instead of sweeping it back to the caller.
describe('P2SH two-phase package prefund @regression @tier1', () => {
  const DOGE = 'dogecoin-regtest'
  const DOGE_REGTEST_NET = require('../../src/CryptoNetworks').getBitcoinJsNetwork(DOGE)
  const RATE_KB = 1000000                       // 1000 koinu/byte, the venue rate
  const TARGET_PER_BYTE = RATE_KB / 1000
  const pubkeyBuf = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
  const CALLER = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: DOGE_REGTEST_NET }).address
  // Four inputs this size: selection takes two, which is enough to leave a
  // change output at or above the 0.01 DOGE relay floor. That matters - a change
  // that folds into the fee instead of being emitted quietly lifts the commit
  // back over the target rate and the probe stops probing anything.
  const FUNDING_INPUT = 2000000
  const PAYLOAD = 'x'.repeat(400)
  // The dust floor, and far under the target rate for a two-input funding tx:
  // the congestion-clamped commit the ledger entry describes.
  const UNDER_TARGET_COMMIT_FEE = 100000

  function prevTxHex () {
    const tx = new bitcoin.Transaction()
    tx.addInput(Buffer.alloc(32, 0x11), 0)
    for (let i = 0; i < 4; i++) {
      tx.addOutput(bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest }).output, FUNDING_INPUT)
    }
    return tx.toHex()
  }

  function makeEncoder (commitPackage) {
    const encoder = new XChainEncoder(DOGE, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
    encoder.connector = {
      getFeePerKilobyte: async () => 0.01,
      getTransactionHex: async () => prevTxHex()
    }
    if (commitPackage !== undefined) {
      encoder.connector.getUnconfirmedAncestorPackage = async () =>
        (typeof commitPackage === 'function' ? commitPackage() : commitPackage)
    }
    return encoder
  }

  function legacyUtxos () {
    const p2pkh = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest })
    return [0, 1, 2, 3].map(vout => ({
      txid: TXID_PARENT_A, vout, value: FUNDING_INPUT, confirmations: 6, scriptPubKey: p2pkh.output.toString('hex')
    }))
  }

  async function buildFunding (encoder, commitFee) {
    encoder.clearReservations()
    const res = await encoder.createTransaction(
      legacyUtxos(), CALLER, null, PAYLOAD, null, commitFee, false, 'P2SH', CALLER,
      null, null, null, true, RATE_KB)
    return res.psbt.__CACHE.__TX
  }

  async function buildReveal (encoder, fundingTx) {
    const res = await encoder.createTransaction(
      [], CALLER, null, PAYLOAD, null, null, false, 'P2SH', CALLER,
      fundingTx.getId(), fundingTx.toHex(), null, true, RATE_KB)
    return res.psbt.__CACHE.__TX
  }

  const legTotal = (tx) => tx.outs
    .filter(o => o.script.toString('hex').startsWith('a914'))
    .reduce((s, o) => s + o.value, 0)

  it('funds the package rate into the leg when the commit pays under target', async () => {
    const atTarget = await buildFunding(makeEncoder(), null)
    const underTarget = await buildFunding(makeEncoder(), UNDER_TARGET_COMMIT_FEE)
    assert.ok(legTotal(underTarget) > legTotal(atTarget),
      `an under-target commit must over-fund its leg (${legTotal(underTarget)} vs ${legTotal(atTarget)})`)
  })

  it('the reveal keeps the package money as fee instead of sweeping it back', async () => {
    const funding = await buildFunding(makeEncoder(), UNDER_TARGET_COMMIT_FEE)
    const commitSize = funding.virtualSize()
    // What the commit ACTUALLY pays: a sub-floor change would have folded into
    // the fee and quietly lifted it back over target.
    const commitFee = funding.ins.length * FUNDING_INPUT - funding.outs.reduce((s, o) => s + o.value, 0)
    assert.ok(commitFee / commitSize < TARGET_PER_BYTE,
      `this probe is only meaningful while the commit is under target (${commitFee / commitSize})`)

    // The node reports the commit exactly as it was broadcast: its real size and
    // the under-target fee the caller chose.
    const packaged = await buildReveal(
      makeEncoder({ size: commitSize, fees: commitFee / SATOSHI_UNIT }), funding)
    // Control: the same reveal built against a node that cannot price the commit.
    const unpackaged = await buildReveal(makeEncoder(), funding)

    const legs = legTotal(funding)
    const packagedFee = legs - packaged.outs.reduce((s, o) => s + o.value, 0)
    const unpackagedFee = legs - unpackaged.outs.reduce((s, o) => s + o.value, 0)
    assert.ok(packagedFee > unpackagedFee,
      `the reveal must keep the package money (${packagedFee} vs ${unpackagedFee})`)

    // The reveal's own priced size, recovered from the control: at exactly
    // 1000 koinu/byte an unpackaged fee IS the size in bytes.
    const revealSize = unpackagedFee / TARGET_PER_BYTE
    const packageRate = (commitFee + packagedFee) / (commitSize + revealSize)
    assert.ok(packageRate >= TARGET_PER_BYTE,
      `commit+reveal package pays ${packageRate} koinu/byte, under the ${TARGET_PER_BYTE} target`)

    // And it is still not a full burn: the SDK refuses to sign an outputless reveal.
    const swept = packaged.outs.reduce((s, o) => s + o.value, 0)
    assert.ok(swept > 0, 'the reveal must still leave the caller an output')
  })

  it('a confirmed commit asks the reveal for nothing', async () => {
    const funding = await buildFunding(makeEncoder(), UNDER_TARGET_COMMIT_FEE)
    // An empty package is what the connector reports once the commit confirms; a
    // confirmed parent is nobody's ancestor for fee purposes any more.
    const confirmed = await buildReveal(makeEncoder({ size: 0, fees: 0 }), funding)
    const unpackaged = await buildReveal(makeEncoder(), funding)
    assert.strictEqual(confirmed.toHex(), unpackaged.toHex(),
      'a confirmed commit must leave the reveal byte-identical')
  })

  it('degrades to the per-transaction fee when the commit lookup throws', async () => {
    const funding = await buildFunding(makeEncoder(), UNDER_TARGET_COMMIT_FEE)
    const thrown = await buildReveal(makeEncoder(() => { throw new Error('node RPC exploded') }), funding)
    const unpackaged = await buildReveal(makeEncoder(), funding)
    assert.strictEqual(thrown.toHex(), unpackaged.toHex())
  })
})
