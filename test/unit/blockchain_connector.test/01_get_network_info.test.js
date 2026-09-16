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

// Capture and restore axios.post between tests
function registerAxiosHooks () {
  let originalPost
  beforeEach(() => {
    originalPost = axios.post
  })
  afterEach(() => {
    axios.post = originalPost
  })
}

describe('BlockchainConnector.getNetworkInfo()', () => {
  registerAxiosHooks()
  it('sends the correct JSON-RPC method', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { version: 220000, subversion: '/Satoshi:22.0.0/' } } }
    }

    const c = makeConnector()
    await c.getNetworkInfo()
    assert.strictEqual(capturedPayload.method, 'getnetworkinfo')
    assert.strictEqual(capturedPayload.jsonrpc, '2.0')
    assert.strictEqual(capturedPayload.id, 1)
  })

  it('passes auth credentials to axios', async () => {
    let capturedOptions
    axios.post = async (url, data, options) => {
      capturedOptions = options
      return { data: { result: { version: 1 } } }
    }

    const c = makeConnector()
    await c.getNetworkInfo()
    assert.strictEqual(capturedOptions.auth.username, 'rpcuser')
    assert.strictEqual(capturedOptions.auth.password, 'rpcpass')
  })

  it('returns the result object on success', async () => {
    stubAxiosPost({ data: { result: { version: 220000, subversion: '/Satoshi:22.0.0/' } } })
    const c = makeConnector()
    const info = await c.getNetworkInfo()
    assert.strictEqual(info.version, 220000)
    assert.strictEqual(info.subversion, '/Satoshi:22.0.0/')
  })

  it('throws when result is missing from response', async () => {
    stubAxiosPost({ data: { result: null } })
    const c = makeConnector()
    await assert.rejects(
      () => c.getNetworkInfo(),
      /Error in network request/
    )
  })
})

describe('BlockchainConnector.getNetworkInfo()', () => {
  registerAxiosHooks()
  it('wraps axios transport errors', async () => {
    stubAxiosPostThrow(new Error('ECONNREFUSED'))
    const c = makeConnector()
    await assert.rejects(
      () => c.getNetworkInfo(),
      /Error in network request.*ECONNREFUSED/
    )
  })

  // A warming node answers -28 "Loading block index..."; LTC/DOGE carry that in
  // an HTTP 500 body, BTC v28 in an HTTP 200 one. Both must keep the RPC code and
  // message: a bare status line leaves warmup indistinguishable from a network fault.
  it('keeps the node RPC code and message from an HTTP-500 error body', async () => {
    const err = new Error('Request failed with status code 500')
    err.response = { status: 500, data: { error: { code: -28, message: 'Loading block index...' } } }
    err.config = { auth: { username: 'rpcuser', password: 'FAKEPASS_must_never_be_logged_9c2d' } }
    stubAxiosPostThrow(err)
    const c = makeConnector()
    await assert.rejects(() => c.getNetworkInfo(), (e) => {
      assert.ok(/^Error in network request/.test(e.message), e.message)
      assert.ok(e.message.includes('-28'), e.message)
      assert.ok(e.message.includes('Loading block index'), e.message)
      assert.ok(!e.message.includes('FAKEPASS'), 'the RPC password must never reach the message')
      return true
    })
  })

  it('keeps the node RPC code and message from an HTTP-200 error body', async () => {
    stubAxiosPost({ data: { result: null, error: { code: -28, message: 'Loading block index...' } } })
    const c = makeConnector()
    await assert.rejects(() => c.getNetworkInfo(), (e) => {
      assert.ok(/^Error in network request/.test(e.message), e.message)
      assert.ok(e.message.includes('-28'), e.message)
      assert.ok(e.message.includes('Loading block index'), e.message)
      return true
    })
  })

  it('sets a timeout on the request', async () => {
    let capturedOptions
    axios.post = async (url, data, options) => {
      capturedOptions = options
      return { data: { result: { version: 1 } } }
    }
    const c = makeConnector()
    await c.getNetworkInfo()
    assert.ok(typeof capturedOptions.timeout === 'number' && capturedOptions.timeout > 0,
      'timeout must be a positive number')
  })
})
