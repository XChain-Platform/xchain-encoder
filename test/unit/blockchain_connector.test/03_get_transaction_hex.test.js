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
  it('sends getrawtransaction with correct txid and hexFormat=true', async () => {
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

  it('passes hexFormat=false when requested', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { hex: HEX } } }
    }
    const c = makeConnector()
    await c.getTransactionHex(TXID, false)
    assert.deepStrictEqual(capturedPayload.params, [TXID, false])
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
