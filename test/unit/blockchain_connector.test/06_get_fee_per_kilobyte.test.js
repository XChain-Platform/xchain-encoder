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
const axios = require('axios')
const BlockchainConnector = require('../../../src/build/blockchain_connector')
const { getLogger } = require('../../../src/observability');
const logger = getLogger();

function makeConnector () {
  return new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
}

function stubAxiosPostThrow (err) {
  axios.post = async () => { throw err }
}

function registerAxiosHooks () {
  let originalPost
  beforeEach(() => {
    originalPost = axios.post
  })
  afterEach(() => {
    axios.post = originalPost
  })
}

let originalNetwork, originalCeiling, warnSpy, errorSpy

function registerSanityHooks () {
    beforeEach(() => {
      originalNetwork = process.env.NETWORK
      originalCeiling = process.env.FEE_ESTIMATE_SANITY_CEILING
      delete process.env.NETWORK
      delete process.env.FEE_ESTIMATE_SANITY_CEILING
      errorSpy = []
      // Spy at the logger boundary, not console.error: this diagnostic now
      // routes through observability/index.js's logger, whose _lazyLogger
      // falls through to console.error only until some earlier-run test file
      // has installed a real shipper in the shared _logger singleton, after
      // which it no longer touches console at all.
      warnSpy = logger.error
      logger.error = (...args) => { errorSpy.push(args.join(' ')); }
    })

    afterEach(() => {
      if (originalNetwork === undefined) delete process.env.NETWORK; else process.env.NETWORK = originalNetwork
      if (originalCeiling === undefined) delete process.env.FEE_ESTIMATE_SANITY_CEILING; else process.env.FEE_ESTIMATE_SANITY_CEILING = originalCeiling
      logger.error = warnSpy
    })
}

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  registerAxiosHooks()
  // getFeePerKilobyte now consults isRegtest() FIRST (getblockchaininfo): on regtest
  // it returns the relayfee floor and never calls estimatesmartfee; only non-regtest
  // nodes reach the estimatesmartfee path. These tests therefore stub the chain.
  it('sends estimatesmartfee with the blocksNumber param (non-regtest)', async () => {
    let capturedFeePayload
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      if (data.method === 'estimatesmartfee') { capturedFeePayload = data; return { data: { result: { feerate: 0.00005 } } } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    await c.getFeePerKilobyte(6)
    assert.strictEqual(capturedFeePayload.method, 'estimatesmartfee')
    assert.deepStrictEqual(capturedFeePayload.params, [6])
  })

  it('returns feerate when present (non-regtest)', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      return { data: { result: { feerate: 0.00012345 } } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(3)
    assert.strictEqual(feerate, 0.00012345)
  })

  it('uses the relayfee floor on regtest and never consults estimatesmartfee', async () => {
    // Regression for the deep-regtest fee-inflation bug: on regtest, even when
    // estimatesmartfee WOULD return a (large) value, the connector must ignore it
    // and use the node's relayfee floor. We assert estimatesmartfee is never sent.
    let smartFeeCalled = false
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'regtest' } } }
      if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.00001000 } } }
      if (data.method === 'estimatesmartfee') { smartFeeCalled = true; return { data: { result: { feerate: 0.1386 } } } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(1)
    assert.strictEqual(feerate, 0.00001000)
    assert.strictEqual(smartFeeCalled, false, 'estimatesmartfee must not be consulted on regtest')
  })

  it('falls back to the regtest default when relayfee is unavailable', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'regtest' } } }
      if (data.method === 'getnetworkinfo') return { data: { result: {} } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(1)
    assert.strictEqual(feerate, 0.00001000)
  })
})

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  registerAxiosHooks()
  it('throws when feerate is missing and chain is not regtest', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    await assert.rejects(
      () => c.getFeePerKilobyte(1),
      /Error getting smart fee from node/
    )
  })

  // A public testnet can be fully synced with an empty mempool and still have no
  // fee history, so estimatesmartfee answers feerate:-1 (DOGE testnet does exactly
  // this). Non-mainnet chains fall back to 10x the node's relayfee floor (the bare
  // floor is rejected by Dogecoin 1.14's free-tx priority gate as "66: insufficient
  // priority"); mainnet must keep failing, because there a missing estimate means
  // the node is unhealthy.
  it('falls back to 10x the relayfee floor on testnet when estimatesmartfee has no data', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
      if (data.method === 'estimatesmartfee') return { data: { result: { feerate: -1, blocks: 25 } } }
      if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.001 } } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(6)
    assert.ok(Math.abs(feerate - 0.01) < 1e-12, 'expected 0.01 DOGE/kB, got ' + feerate)
  })

  // The documented 10x rate is not always minable: on Dogecoin testnet, measured
  // over 400 blocks, transactions land at 0.03 and around 1.0 DOGE per kB while
  // 0.0102 sat unmined. Only the operator running a given chain can measure what
  // it takes there, so the multiple is deployment-tunable.
  it('honours FEE_NO_ESTIMATE_RELAY_MULTIPLIER for the no-estimate fallback', async () => {
    process.env.FEE_NO_ESTIMATE_RELAY_MULTIPLIER = '100'
    try {
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
        if (data.method === 'estimatesmartfee') return { data: { result: { feerate: -1 } } }
        if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.001 } } }
        return { data: { result: {} } }
      }
      const c = makeConnector()
      const feerate = await c.getFeePerKilobyte(6)
      assert.ok(Math.abs(feerate - 0.1) < 1e-12, 'expected 0.1 DOGE/kB at 100x, got ' + feerate)
    } finally {
      delete process.env.FEE_NO_ESTIMATE_RELAY_MULTIPLIER
    }
  })
})

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  registerAxiosHooks()
  it('ignores a non-positive or unparseable multiplier and keeps the default', async () => {
    for (const bad of ['0', '-5', 'abc']) {
      process.env.FEE_NO_ESTIMATE_RELAY_MULTIPLIER = bad
      try {
        axios.post = async (url, data) => {
          if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
          if (data.method === 'estimatesmartfee') return { data: { result: { feerate: -1 } } }
          if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.001 } } }
          return { data: { result: {} } }
        }
        const c = makeConnector()
        const feerate = await c.getFeePerKilobyte(6)
        assert.ok(Math.abs(feerate - 0.01) < 1e-12, bad + ' must fall back to 10x, got ' + feerate)
      } finally {
        delete process.env.FEE_NO_ESTIMATE_RELAY_MULTIPLIER
      }
    }
  })

  it('still prefers the estimate over the relayfee floor on testnet when one exists', async () => {
    let networkInfoCalled = false
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
      if (data.method === 'estimatesmartfee') return { data: { result: { feerate: 0.005 } } }
      if (data.method === 'getnetworkinfo') { networkInfoCalled = true; return { data: { result: { relayfee: 0.001 } } } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(6)
    assert.strictEqual(feerate, 0.005)
    assert.strictEqual(networkInfoCalled, false, 'relayfee must not be consulted when an estimate exists')
  })

  it('throws on testnet when neither an estimate nor a relayfee is available', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
      if (data.method === 'estimatesmartfee') return { data: { result: { feerate: -1 } } }
      if (data.method === 'getnetworkinfo') return { data: { result: {} } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    await assert.rejects(() => c.getFeePerKilobyte(1), /Error getting smart fee from node/)
  })
})

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  registerAxiosHooks()
  it('does NOT fall back to the relayfee floor on mainnet', async () => {
    let networkInfoCalled = false
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      if (data.method === 'estimatesmartfee') return { data: { result: { feerate: -1 } } }
      if (data.method === 'getnetworkinfo') { networkInfoCalled = true; return { data: { result: { relayfee: 0.00001 } } } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    await assert.rejects(() => c.getFeePerKilobyte(1), /Error getting smart fee from node/)
    assert.strictEqual(networkInfoCalled, false, 'mainnet must never substitute the relay floor for a missing estimate')
  })

  it('rethrows transport errors', async () => {
    stubAxiosPostThrow(new Error('Connection refused'))
    const c = makeConnector()
    await assert.rejects(
      () => c.getFeePerKilobyte(1),
      /Connection refused/
    )
  })

  it('throws when result is entirely missing (non-regtest)', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      return { data: { result: null } }
    }
    const c = makeConnector()
    await assert.rejects(
      () => c.getFeePerKilobyte(1),
      /Error getting smart fee from node/
    )
  })
})

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  registerAxiosHooks()
  // A node reports "no fee estimate" in two shapes, and only one of them is a
  // success body carrying feerate:-1. LTC/DOGE answer HTTP 500 with a JSON-RPC
  // error body, so axios throws before the try-block fallback is reached; the
  // testnet relay-multiplier fallback has to run on that shape too, or a public
  // testnet node in an ordinary state fails every fee-bearing build.
  describe('no-estimate reported as an RPC error rather than feerate:-1', () => {
    it('falls back to 10x the relayfee floor on testnet when estimatesmartfee throws', async () => {
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
        if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.001 } } }
        if (data.method === 'estimatesmartfee') {
          const err = new Error('Request failed with status code 500')
          err.response = { status: 500, data: { error: { code: -1, message: 'Insufficient data' } } }
          throw err
        }
        return { data: { result: {} } }
      }
      const c = makeConnector()
      const feerate = await c.getFeePerKilobyte(6)
      assert.ok(Math.abs(feerate - 0.01) < 1e-12, 'expected 10x the 0.001 relay floor, got ' + feerate)
    })

    it('still rejects on testnet when the node reports no relayfee either', async () => {
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
        if (data.method === 'getnetworkinfo') return { data: { result: {} } }
        if (data.method === 'estimatesmartfee') throw new Error('Request failed with status code 500')
        return { data: { result: {} } }
      }
      const c = makeConnector()
      await assert.rejects(() => c.getFeePerKilobyte(6), /status code 500/)
    })

    it('does NOT invent a rate on mainnet when estimatesmartfee throws', async () => {
      let networkInfoCalled = false
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
        if (data.method === 'getnetworkinfo') { networkInfoCalled = true; return { data: { result: { relayfee: 0.001 } } } }
        if (data.method === 'estimatesmartfee') throw new Error('Request failed with status code 500')
        return { data: { result: {} } }
      }
      const c = makeConnector()
      await assert.rejects(() => c.getFeePerKilobyte(6), /status code 500/)
      assert.strictEqual(networkInfoCalled, false, 'mainnet must never substitute the relay floor')
    })

    it('keeps a node-down failure a failure', async () => {
      stubAxiosPostThrow(new Error('ECONNREFUSED'))
      const c = makeConnector()
      await assert.rejects(() => c.getFeePerKilobyte(6), /ECONNREFUSED/)
    })
  })
})

// estimatesmartfee was taken verbatim on testnet/mainnet with no
// upper bound. A misbehaving/compromised/misconfigured node feeding a
// spiked estimate on this money-affecting path fed straight into what the
// caller was charged, and into the caller-facing caps' own anchor.
describe('BlockchainConnector.getFeePerKilobyte()', () => {
  registerAxiosHooks()
  describe('sanity ceiling on the raw non-regtest estimate', () => {
    registerSanityHooks()
    it('clamps a spiked mainnet estimate to the coin-default ceiling and logs loudly', async () => {
      process.env.NETWORK = 'bitcoin-mainnet'
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
        if (data.method === 'estimatesmartfee') return { data: { result: { feerate: 5 } } } // 5 BTC/kB: absurd
        return { data: { result: {} } }
      }
      const c = makeConnector()
      const feerate = await c.getFeePerKilobyte(1)
      assert.strictEqual(feerate, 0.01, 'expected clamp to the bitcoin default ceiling 0.01 BTC/kB')
      assert.ok(errorSpy.some(m => /sanity ceiling/.test(m)), 'expected a loud diagnostic')
    })

    it('clamps a spiked testnet estimate using the dogecoin-scale default when NETWORK says dogecoin', async () => {
      process.env.NETWORK = 'dogecoin-testnet'
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
        if (data.method === 'estimatesmartfee') return { data: { result: { feerate: 5000 } } } // 5000 DOGE/kB: absurd
        return { data: { result: {} } }
      }
      const c = makeConnector()
      const feerate = await c.getFeePerKilobyte(6)
      assert.strictEqual(feerate, 10, 'expected clamp to the dogecoin default ceiling 10 DOGE/kB')
    })
  })
})

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  registerAxiosHooks()
  describe('sanity ceiling on the raw non-regtest estimate', () => {
    registerSanityHooks()
    it('passes through an estimate under the ceiling unchanged', async () => {
      process.env.NETWORK = 'bitcoin-mainnet'
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
        if (data.method === 'estimatesmartfee') return { data: { result: { feerate: 0.0005 } } }
        return { data: { result: {} } }
      }
      const c = makeConnector()
      const feerate = await c.getFeePerKilobyte(1)
      assert.strictEqual(feerate, 0.0005)
      assert.strictEqual(errorSpy.length, 0, 'must not log when under the ceiling')
    })

    it('honours FEE_ESTIMATE_SANITY_CEILING as an override', async () => {
      process.env.NETWORK = 'bitcoin-mainnet'
      process.env.FEE_ESTIMATE_SANITY_CEILING = '0.0001'
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
        if (data.method === 'estimatesmartfee') return { data: { result: { feerate: 0.0005 } } }
        return { data: { result: {} } }
      }
      const c = makeConnector()
      const feerate = await c.getFeePerKilobyte(1)
      assert.strictEqual(feerate, 0.0001, 'expected clamp to the overridden ceiling')
    })
  })
})

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  registerAxiosHooks()
  describe('sanity ceiling on the raw non-regtest estimate', () => {
    registerSanityHooks()
    it('ignores a non-positive or unparseable override and keeps the coin default', async () => {
      process.env.NETWORK = 'litecoin-mainnet'
      process.env.FEE_ESTIMATE_SANITY_CEILING = '-1'
      axios.post = async (url, data) => {
        if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
        if (data.method === 'estimatesmartfee') return { data: { result: { feerate: 5 } } }
        return { data: { result: {} } }
      }
      const c = makeConnector()
      const feerate = await c.getFeePerKilobyte(1)
      assert.strictEqual(feerate, 0.01, 'expected fallback to the litecoin default ceiling')
    })
  })
})
