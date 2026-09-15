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
const util = require('util');

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

// Behavioral lock: every RPC call passes auth:{username,password} to axios, and
// axios attaches that config to the thrown error. Logging or re-throwing the raw
// error serializes the node RPC password into the encoder logs. Drive a failing
// getTransactionHex and assert the password never reaches console.error and is
// scrubbed from the re-thrown error. FAKE_RPC_PASSWORD is a test sentinel.

describe('BlockchainConnector RPC-credential log sanitization', () => {
  registerAxiosHooks()
  it('does not leak the RPC password when an axios call fails', async () => {
    const FAKE_RPC_PASSWORD = 'FAKEPASS_must_never_be_logged_9c3f'

    const err = new Error('Request failed with status code 401')
    err.code = 'ERR_BAD_REQUEST'
    err.config = {
      auth: { username: 'rpcuser', password: FAKE_RPC_PASSWORD },
      headers: { Authorization: 'Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') }
    }
    err.request = { _header: 'Authorization: Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') }
    err.response = { status: 401, data: 'unauthorized', config: err.config }

    const c = new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', FAKE_RPC_PASSWORD)
    stubAxiosPostThrow(err)

    const originalError = console.error
    const logs = []
    console.error = (...args) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 8 }))).join(' '))
    }

    let thrown
    try {
      await c.getTransactionHex('deadbeef')
    } catch (e) {
      thrown = e
    } finally {
      console.error = originalError
    }

    const combined = logs.join('\n')
    assert.ok(thrown, 'the failing RPC should propagate an error')
    assert.ok(!combined.includes(FAKE_RPC_PASSWORD),
      'the RPC password must never appear in connector error logs (got: ' + combined + ')')
    assert.strictEqual(thrown.config && thrown.config.auth, undefined,
      'the re-thrown error must have its config.auth scrubbed')
  })
})
