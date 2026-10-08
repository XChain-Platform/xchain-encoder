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

function makeConnector () {
  return new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
}

// Answer getblockchaininfo as mainnet, where a missing estimate always throws.
function stubMainnet (onSmartFee) {
  axios.post = async (url, data) => {
    if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
    if (data.method === 'estimatesmartfee') return onSmartFee()
    return { data: { result: {} } }
  }
}

describe('BlockchainConnector.getFeePerKilobyte() node RPC error detail', () => {
  let originalPost
  beforeEach(() => { originalPost = axios.post })
  afterEach(() => { axios.post = originalPost })

  it('carries the error body of an HTTP 500 answer into the thrown message', async () => {
    stubMainnet(() => {
      const err = new Error('Request failed with status code 500')
      err.response = { status: 500, data: { error: { code: -28, message: 'Loading block index...' } } }
      throw err
    })
    const c = makeConnector()
    await assert.rejects(() => c.getFeePerKilobyte(6), /status code 500 \(RPC error -28: Loading block index\.\.\.\)/)
  })

  it('carries the error body of an HTTP 200 answer into the thrown message', async () => {
    stubMainnet(() => ({ data: { result: null, error: { code: -32601, message: 'Method not found' } } }))
    const c = makeConnector()
    await assert.rejects(() => c.getFeePerKilobyte(6), /Error getting smart fee from node \(RPC error -32601: Method not found\)/)
  })

  it('carries a modern node result.errors reason into the thrown message', async () => {
    stubMainnet(() => ({ data: { result: { errors: ['Insufficient data or no feerate found'], blocks: 2 }, error: null } }))
    const c = makeConnector()
    await assert.rejects(() => c.getFeePerKilobyte(6),
      /Error getting smart fee from node \(node: Insufficient data or no feerate found\)/)
  })

  it('adds no suffix for a feerate -1 body or result.errors with no usable string', async () => {
    const bodies = [{ feerate: -1, blocks: 25 }, { errors: [], blocks: 2 }, { errors: [null, 42, ''], blocks: 2 }]
    for (const result of bodies) {
      stubMainnet(() => ({ data: { result: result } }))
      const c = makeConnector()
      await assert.rejects(() => c.getFeePerKilobyte(6), (err) => err.message === 'Error getting smart fee from node')
    }
  })

  it('still takes the testnet relay fallback for a modern no-estimate body', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'test' } } }
      if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.001 } } }
      if (data.method === 'estimatesmartfee') return { data: { result: { errors: ['Insufficient data or no feerate found'], blocks: 2 }, error: null } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    assert.strictEqual(await c.getFeePerKilobyte(6), 0.01)
  })

  it('rethrows a bodiless transport failure as the original error object', async () => {
    const original = new Error('socket hang up')
    stubMainnet(() => { throw original })
    const c = makeConnector()
    await assert.rejects(() => c.getFeePerKilobyte(6), (err) => err === original)
  })
})
