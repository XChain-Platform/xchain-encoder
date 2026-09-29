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

const TXID = 'a'.repeat(64)
const HEX = '0100000001' + '0'.repeat(100)

describe('BlockchainConnector.getTransactionHex()', () => {
  registerAxiosHooks()
  it('sends getrawtransaction with correct txid and verbose=true', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { hex: HEX } } }
    }
    const c = makeConnector()
    await c.getTransactionHex(TXID)
    assert.strictEqual(capturedPayload.method, 'getrawtransaction')
    assert.deepStrictEqual(capturedPayload.params, [TXID, true])
  })

  it('requests the verbose form even when a caller passes a second argument', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { hex: HEX } } }
    }
    const c = makeConnector()
    const result = await c.getTransactionHex(TXID, false)
    assert.deepStrictEqual(capturedPayload.params, [TXID, true])
    assert.strictEqual(result, HEX)
  })

  it('returns the hex string on success', async () => {
    stubAxiosPost({ data: { result: { hex: HEX } } })
    const c = makeConnector()
    const result = await c.getTransactionHex(TXID)
    assert.strictEqual(result, HEX)
  })

  it('throws "not found" message when error.code is -5', async () => {
    stubAxiosPost({ data: { error: { code: -5, message: 'No such mempool or blockchain transaction' } } })
    const c = makeConnector()
    await assert.rejects(
      () => c.getTransactionHex(TXID),
      /not found.*txindex/
    )
  })

  it('includes the txid in the "not found" error message', async () => {
    stubAxiosPost({ data: { error: { code: -5, message: 'tx not found' } } })
    const c = makeConnector()
    await assert.rejects(
      () => c.getTransactionHex(TXID),
      new RegExp(TXID.slice(0, 8))
    )
  })
})

describe('BlockchainConnector.getTransactionHex()', () => {
  registerAxiosHooks()
  it('throws generic error when result is missing and error is not -5', async () => {
    stubAxiosPost({ data: { result: null, error: null } })
    const c = makeConnector()
    await assert.rejects(
      () => c.getTransactionHex(TXID),
      /Error getting transaction hex/
    )
  })

  it('rethrows transport errors directly', async () => {
    stubAxiosPostThrow(new Error('Network failure'))
    const c = makeConnector()
    await assert.rejects(
      () => c.getTransactionHex(TXID),
      /Network failure/
    )
  })

  it('sends auth credentials', async () => {
    let capturedOptions
    axios.post = async (url, data, options) => {
      capturedOptions = options
      return { data: { result: { hex: HEX } } }
    }
    const c = makeConnector()
    await c.getTransactionHex(TXID)
    assert.strictEqual(capturedOptions.auth.username, 'rpcuser')
    assert.strictEqual(capturedOptions.auth.password, 'rpcpass')
  })
})

// LTC/DOGE answer RPC-level errors as HTTP 500 with a JSON-RPC body, so axios
// throws; build that error the way axios does, credentials attached.
function http500 (code, message) {
  const err = new Error('Request failed with status code 500')
  err.code = 'ERR_BAD_RESPONSE'
  err.config = { auth: { username: 'rpcuser', password: 'FAKEPASS_must_never_be_logged_03' } }
  err.response = { status: 500, data: { error: { code, message } } }
  return err
}

describe('BlockchainConnector.getTransactionHex() node RPC error detail', () => {
  registerAxiosHooks()
  const { upstreamErrorMessage } = require('../../../src/common/error_sanitize')

  it('keeps the code and message of an HTTP 500 -28 answer', async () => {
    stubAxiosPostThrow(http500(-28, 'Loading block index...'))
    const c = makeConnector()
    let thrown
    try { await c.getTransactionHex(TXID) } catch (e) { thrown = e }
    assert.ok(thrown, 'should reject')
    assert.match(thrown.message, /status code 500 \(RPC error -28: Loading block index\.\.\.\)/)
    assert.ok(!thrown.message.includes('FAKEPASS'), 'no credential in the message')
    assert.strictEqual(thrown.code, undefined, 'a plain Error, not the axios ERR_BAD_RESPONSE')
    assert.notStrictEqual(upstreamErrorMessage(thrown, 'FALLBACK'), 'FALLBACK')
  })

  it('keeps the code and message of an HTTP 500 -8 answer', async () => {
    stubAxiosPostThrow(http500(-8, 'parameter 1 must be hexadecimal string'))
    const c = makeConnector()
    await assert.rejects(() => c.getTransactionHex(TXID),
      /\(RPC error -8: parameter 1 must be hexadecimal string\)/)
  })

  it('still gives the txindex hint for an HTTP 500 -5 answer', async () => {
    stubAxiosPostThrow(http500(-5, 'No such mempool or blockchain transaction'))
    const c = makeConnector()
    await assert.rejects(() => c.getTransactionHex(TXID), /not found.*txindex/)
  })

  it('keeps the code and message of an HTTP 200 error body', async () => {
    stubAxiosPost({ data: { result: null, error: { code: -28, message: 'Loading block index...' } } })
    const c = makeConnector()
    await assert.rejects(() => c.getTransactionHex(TXID),
      /Error getting transaction hex \(RPC error -28: Loading block index\.\.\.\)/)
  })

  it('logs the node reason rather than a bare status code', async () => {
    stubAxiosPostThrow(http500(-28, 'Loading block index...'))
    const c = makeConnector()
    const originalError = console.error
    const logs = []
    console.error = (...args) => { logs.push(args.join(' ')) }
    try {
      await c.getTransactionHex(TXID).catch(() => {})
    } finally {
      console.error = originalError
    }
    const combined = logs.join('\n')
    assert.ok(combined.includes('RPC error -28: Loading block index...'), 'log should carry the node reason (got: ' + combined + ')')
    assert.ok(!combined.includes('FAKEPASS'), 'no credential in the log')
  })

  it('rethrows a bodiless transport failure as the original error object', async () => {
    const original = new Error('socket hang up')
    stubAxiosPostThrow(original)
    const c = makeConnector()
    await assert.rejects(() => c.getTransactionHex(TXID), (err) => err === original)
  })
})
