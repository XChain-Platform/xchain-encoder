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
const CryptoNetworks = require('../../../src/build/crypto_networks')
const { logger } = require('../../../src/build/blockchain_connector/constants')

const BTC_MAINNET = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const DOGE_MAINNET = '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691'

function makeConnector (consensusNetwork, chainGenesisHash) {
  return new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass', consensusNetwork, chainGenesisHash)
}

// Answer getblockchaininfo with `chain` and getblockhash with `hashBody`, counting calls per method.
function stubNode (chain, hashBody, counts) {
  axios.post = async (url, data) => {
    counts[data.method] = (counts[data.method] || 0) + 1
    if (data.method === 'getblockchaininfo') {
      if (chain instanceof Error) throw chain
      return { data: { result: { chain } } }
    }
    if (data.method === 'getblockhash') return { data: hashBody }
    throw new Error('unexpected method ' + data.method)
  }
}

function registerHooks (warnings) {
  let originalPost
  let originalWarn
  beforeEach(() => {
    originalPost = axios.post
    originalWarn = logger.warn
    warnings.length = 0
    logger.warn = (msg) => warnings.push(msg)
  })
  afterEach(() => {
    axios.post = originalPost
    logger.warn = originalWarn
  })
}

// Assert a refusal is the operational NODE_CHAIN_MISMATCH with no endpoint or credential in it.
function isChainMismatch (err) {
  assert.strictEqual(err.operational, true)
  assert.strictEqual(err.xchainCode, 'NODE_CHAIN_MISMATCH')
  assert.ok(!/127\.0\.0\.1|18332|rpcuser|rpcpass/.test(err.message), err.message)
  return true
}

describe('BlockchainConnector.assertNodeTier() block-0 hash pin', () => {
  const warnings = []
  registerHooks(warnings)

  for (const pin of [null, '']) {
    it(`sends no getblockhash while the pin is ${JSON.stringify(pin)}`, async () => {
      const counts = {}
      stubNode('main', { result: DOGE_MAINNET }, counts)
      await makeConnector('mainnet', pin).assertNodeTier()
      assert.strictEqual(counts.getblockhash, undefined)
    })
  }

  it('passes a matching hash in any case and caches the pass', async () => {
    const counts = {}
    stubNode('main', { result: BTC_MAINNET.toUpperCase() }, counts)
    const connector = makeConnector('mainnet', BTC_MAINNET)
    await connector.assertNodeTier()
    await connector.assertNodeTier()
    assert.deepStrictEqual(counts, { getblockchaininfo: 1, getblockhash: 1 })
    assert.strictEqual(connector.nodeGenesisOk, true)
  })

  it('refuses a node on the same tier with a different block-0 hash, every call', async () => {
    const counts = {}
    stubNode('main', { result: DOGE_MAINNET }, counts)
    const connector = makeConnector('mainnet', BTC_MAINNET)
    await assert.rejects(connector.assertNodeTier(), isChainMismatch)
    await assert.rejects(connector.assertNodeTier(), isChainMismatch)
    assert.strictEqual(counts.getblockhash, 2)
    assert.ok(connector.nodeTierMismatch.includes(DOGE_MAINNET), connector.nodeTierMismatch)
  })

  it('never asks for the hash when the tier already refused the node', async () => {
    const counts = {}
    stubNode('test', { result: BTC_MAINNET }, counts)
    await assert.rejects(makeConnector('mainnet', BTC_MAINNET).assertNodeTier(), isChainMismatch)
    assert.strictEqual(counts.getblockhash, undefined)
  })
})

describe('BlockchainConnector.assertNodeTier() block-0 hash pin when the node cannot answer', () => {
  const warnings = []
  registerHooks(warnings)

  for (const [label, body] of [['an error body', { error: { code: -8, message: 'Block height out of range' } }],
    ['a malformed result', { result: 'not-a-hash' }]]) {
    it(`lets ${label} through, warning once and retrying on the next call`, async () => {
      const counts = {}
      stubNode('main', body, counts)
      const connector = makeConnector('mainnet', BTC_MAINNET)
      await connector.assertNodeTier()
      await connector.assertNodeTier()
      assert.strictEqual(counts.getblockhash, 2)
      assert.strictEqual(connector.nodeGenesisOk, undefined)
      assert.strictEqual(warnings.filter((w) => /block-0 hash unchecked/.test(w)).length, 1)
    })
  }

  it('still checks the hash when the tier cannot be read', async () => {
    const counts = {}
    stubNode(new Error('connect refused'), { result: BTC_MAINNET }, counts)
    const connector = makeConnector('mainnet', BTC_MAINNET)
    await connector.assertNodeTier()
    assert.strictEqual(connector.nodeTierOk, undefined)
    assert.strictEqual(connector.nodeGenesisOk, true)
  })
})

describe('CryptoNetworks.getChainGenesisHash()', () => {
  it('returns null for every supported network while the registry pins none, and for an unknown key', () => {
    for (const coin of ['bitcoin', 'dogecoin', 'litecoin']) {
      for (const net of ['mainnet', 'testnet', 'regtest']) {
        assert.strictEqual(CryptoNetworks.getChainGenesisHash(`${coin}-${net}`), null)
      }
    }
    assert.strictEqual(CryptoNetworks.getChainGenesisHash('nocoin-mainnet'), null)
  })
})
