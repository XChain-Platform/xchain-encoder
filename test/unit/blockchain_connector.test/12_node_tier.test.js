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
const { logger } = require('../../../src/build/blockchain_connector/constants')

function makeConnector (consensusNetwork) {
  return new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass', consensusNetwork)
}

// Answer every axios.post with one getblockchaininfo chain and count the calls.
function stubChain (chain, counter) {
  axios.post = async () => { counter.calls++; return { data: { result: chain === undefined ? {} : { chain } } } }
}

function registerHooks () {
  let originalPost
  let originalWarn
  beforeEach(() => {
    originalPost = axios.post
    originalWarn = logger.warn
    logger.warn = () => {}
  })
  afterEach(() => {
    axios.post = originalPost
    logger.warn = originalWarn
  })
}

describe('BlockchainConnector.assertNodeTier() chain matching', () => {
  registerHooks()

  const matches = [
    ['mainnet', 'main'], ['testnet', 'test'], ['testnet', 'testnet3'], ['testnet', 'testnet4'], ['regtest', 'regtest'],
  ]
  for (const [network, chain] of matches) {
    it(`passes a ${network} encoder on a node reporting chain "${chain}"`, async () => {
      stubChain(chain, { calls: 0 })
      await makeConnector(network).assertNodeTier()
    })
  }

  const mismatches = [
    ['testnet', 'main'], ['mainnet', 'test'], ['mainnet', 'regtest'], ['mainnet', 'signet'], ['regtest', 'testnet4'],
  ]
  for (const [network, chain] of mismatches) {
    it(`refuses a ${network} encoder on a node reporting chain "${chain}" with NODE_CHAIN_MISMATCH`, async () => {
      stubChain(chain, { calls: 0 })
      await assert.rejects(makeConnector(network).assertNodeTier(), (err) => {
        assert.strictEqual(err.operational, true)
        assert.strictEqual(err.xchainCode, 'NODE_CHAIN_MISMATCH')
        assert.ok(err.message.includes(chain) && err.message.includes(network), err.message)
        assert.ok(!/127\.0\.0\.1|18332|rpcuser|rpcpass/.test(err.message), err.message)
        return true
      })
    })
  }
})

describe('BlockchainConnector.assertNodeTier() pass-through and caching', () => {
  registerHooks()

  it('lets an unrecognized chain string through', async () => {
    stubChain('futurenet', { calls: 0 })
    await makeConnector('mainnet').assertNodeTier()
  })

  it('lets a response with no chain field through, warning once across calls', async () => {
    const counter = { calls: 0 }
    stubChain(undefined, counter)
    const warnings = []
    logger.warn = (msg) => { warnings.push(String(msg)) }
    const c = makeConnector('mainnet')
    await c.assertNodeTier()
    await c.assertNodeTier()
    assert.strictEqual(warnings.length, 1)
    assert.strictEqual(counter.calls, 2, 'an unread chain is retried, never cached as a pass')
  })

  it('lets a transport error through', async () => {
    axios.post = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
    await makeConnector('mainnet').assertNodeTier()
  })

  it('skips the check when no consensus network was given', async () => {
    const counter = { calls: 0 }
    stubChain('main', counter)
    await makeConnector().assertNodeTier()
    assert.strictEqual(counter.calls, 0)
  })

  it('costs no further RPC once a matching node has passed', async () => {
    const counter = { calls: 0 }
    stubChain('test', counter)
    const c = makeConnector('testnet')
    await c.assertNodeTier()
    await c.assertNodeTier()
    await c.isRegtest()
    assert.strictEqual(counter.calls, 1)
  })
})
