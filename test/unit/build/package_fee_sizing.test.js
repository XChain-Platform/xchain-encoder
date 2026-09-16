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

const BlockchainConnector = require('../../../src/build/blockchain_connector')

const util = require('util');

const TXID_PARENT_A = 'a'.repeat(64)
const TXID_PARENT_B = 'b'.repeat(64)
const TXID_SHARED   = 'c'.repeat(64)
const TXID_GRANDPA  = 'd'.repeat(64)

let originalPost

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

  beforeEach(() => { originalPost = axios.post })
  afterEach(() => { axios.post = originalPost })

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

})

describe('BlockchainConnector.getUnconfirmedAncestorPackage() @regression @tier1', () => {

  beforeEach(() => { originalPost = axios.post })
  afterEach(() => { axios.post = originalPost })

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

})

describe('BlockchainConnector.getUnconfirmedAncestorPackage() @regression @tier1', () => {

  beforeEach(() => { originalPost = axios.post })
  afterEach(() => { axios.post = originalPost })

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

})

describe('BlockchainConnector.getUnconfirmedAncestorPackage() @regression @tier1', () => {

  beforeEach(() => { originalPost = axios.post })
  afterEach(() => { axios.post = originalPost })

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

})

describe('BlockchainConnector.getUnconfirmedAncestorPackage() @regression @tier1', () => {

  beforeEach(() => { originalPost = axios.post })
  afterEach(() => { axios.post = originalPost })

  it('returns null when the second call fails for a reason other than absence', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getmempoolentry') return { data: { result: entry(400, 0.001) } }
      return { data: { error: { code: -32603, message: 'Internal error' } } }
    }
    assert.strictEqual(await makeConnector().getUnconfirmedAncestorPackage([TXID_PARENT_A]), null)
  })

  it('does not leak the RPC password when a mempool call fails', async () => {
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
