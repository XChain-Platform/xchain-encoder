// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// On regtest the relay-fee floor comes from getnetworkinfo. A node that answered
// with an RPC error body is not unreachable, so it must not read as an outage.

const assert = require('assert')
const axios = require('axios')
const BlockchainConnector = require('../../../src/build/blockchain_connector')

function regtestConnector () {
  const connector = new BlockchainConnector('127.0.0.1', 18443, 'rpcuser', 'rpcpass')
  connector._chainNameCache = 'regtest'
  return connector
}

function stubNetworkInfo (respond, calls) {
  axios.post = async (url, data) => {
    if (data.method === 'getnetworkinfo') {
      calls.push(data.method)
      return respond()
    }
    return { data: { result: {} } }
  }
}

function answeredWith (status, code, message) {
  const err = new Error(`Request failed with status code ${status}`)
  err.response = { status, data: { error: { code, message } } }
  return err
}

describe('regtest getFeePerKilobyte with a node that answers getnetworkinfo with an error', () => {
  let originalPost
  beforeEach(() => { originalPost = axios.post })
  afterEach(() => { axios.post = originalPost })

  it('keeps an HTTP 500 RPC error as a plain error with the node reason, asked once', async () => {
    const calls = []
    stubNetworkInfo(() => { throw answeredWith(500, -28, 'Loading block index...') }, calls)
    await assert.rejects(() => regtestConnector().getFeePerKilobyte(1), (err) => {
      assert.notStrictEqual(err.operational, true)
      assert.notStrictEqual(err.xchainCode, 'NODE_UNREACHABLE')
      assert.ok(/RPC error -28: Loading block index/.test(err.message), err.message)
      return true
    })
    assert.deepStrictEqual(calls, ['getnetworkinfo'])
  })

  it('keeps an HTTP 200 error body as a plain error, not an outage', async () => {
    stubNetworkInfo(() => ({ data: { result: null, error: { code: -32601, message: 'Method not found' } } }), [])
    await assert.rejects(() => regtestConnector().getFeePerKilobyte(1), (err) => {
      assert.notStrictEqual(err.operational, true)
      assert.ok(/RPC error -32601: Method not found/.test(err.message), err.message)
      return true
    })
  })

  it('still reports a node that never answered as NODE_UNREACHABLE', async () => {
    stubNetworkInfo(() => { const e = new Error('connect ECONNREFUSED 127.0.0.1:18443'); e.code = 'ECONNREFUSED'; throw e }, [])
    await assert.rejects(() => regtestConnector().getFeePerKilobyte(1), (err) => {
      assert.strictEqual(err.operational, true)
      assert.strictEqual(err.xchainCode, 'NODE_UNREACHABLE')
      return true
    })
  })
})
