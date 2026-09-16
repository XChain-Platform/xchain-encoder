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

function stubAxiosPost (response) {
  axios.post = async () => response
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

describe('BlockchainConnector.isRegtest()', () => {
  registerAxiosHooks()
  it('sends getblockchaininfo method', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { chain: 'regtest' } } }
    }
    const c = makeConnector()
    await c.isRegtest()
    assert.strictEqual(capturedPayload.method, 'getblockchaininfo')
  })

  it('returns true when chain is "regtest"', async () => {
    stubAxiosPost({ data: { result: { chain: 'regtest' } } })
    const c = makeConnector()
    assert.strictEqual(await c.isRegtest(), true)
  })

  it('returns false when chain is "main"', async () => {
    stubAxiosPost({ data: { result: { chain: 'main' } } })
    const c = makeConnector()
    assert.strictEqual(await c.isRegtest(), false)
  })

  it('returns false when chain is "test"', async () => {
    stubAxiosPost({ data: { result: { chain: 'test' } } })
    const c = makeConnector()
    assert.strictEqual(await c.isRegtest(), false)
  })

  it('throws when result is missing', async () => {
    stubAxiosPost({ data: { result: null } })
    const c = makeConnector()
    await assert.rejects(
      () => c.isRegtest(),
      /Error in network request/
    )
  })

  it('throws when result has no chain property', async () => {
    stubAxiosPost({ data: { result: {} } })
    const c = makeConnector()
    await assert.rejects(
      () => c.isRegtest(),
      /Error in network request/
    )
  })
})

describe('BlockchainConnector.isRegtest()', () => {
  registerAxiosHooks()
  it('wraps transport errors', async () => {
    stubAxiosPostThrow(new Error('timeout of 30000ms exceeded'))
    const c = makeConnector()
    await assert.rejects(
      () => c.isRegtest(),
      /Error in network request.*timeout/
    )
  })

  it('keeps the node RPC code and message from an HTTP-500 error body', async () => {
    const err = new Error('Request failed with status code 500')
    err.response = { status: 500, data: { error: { code: -28, message: 'Loading block index...' } } }
    stubAxiosPostThrow(err)
    const c = makeConnector()
    await assert.rejects(() => c.chainName(), (e) => {
      assert.ok(/^Error in network request/.test(e.message), e.message)
      assert.ok(e.message.includes('-28'), e.message)
      assert.ok(e.message.includes('Loading block index'), e.message)
      return true
    })
  })

  it('keeps the node RPC code and message from an HTTP-200 error body', async () => {
    stubAxiosPost({ data: { result: null, error: { code: -28, message: 'Loading block index...' } } })
    const c = makeConnector()
    await assert.rejects(() => c.chainName(), (e) => {
      assert.ok(/^Error in network request/.test(e.message), e.message)
      assert.ok(e.message.includes('-28'), e.message)
      assert.ok(e.message.includes('Loading block index'), e.message)
      return true
    })
  })
})
