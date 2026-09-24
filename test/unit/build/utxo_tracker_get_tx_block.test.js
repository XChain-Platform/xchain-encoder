'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const axios = require('axios')
const UtxoTracker = require('../../../src/build/utxo_tracker')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

const TXID = 'a'.repeat(64)
const BLOCK_HASH = 'b'.repeat(64)

function makeController () {
  const tracker = new UtxoTracker('127.0.0.1', 18420)
  return createJsonRpcController({
    encoder: { utxoTrackerConnector: tracker },
    NETWORK: 'dogecoin-testnet'
  })
}

describe('get_tx_block tracker proxy', function () {
  let originalPost

  beforeEach(function () {
    originalPost = axios.post
  })

  afterEach(function () {
    axios.post = originalPost
  })

  it('returns a tracker hit and sends the exact lookup request', async function () {
    const expected = {
      block_hash: BLOCK_HASH,
      block_height: 123,
      sync: { committed_height: 125, committed_hash: 'c'.repeat(64) }
    }
    let request
    axios.post = async (url, data, options) => {
      request = { url, data, options }
      return { data: { jsonrpc: '2.0', id: 1, result: expected } }
    }

    const result = await makeController().get_tx_block({ txid: TXID })

    assert.strictEqual(result, expected)
    assert.strictEqual(request.url, 'http://127.0.0.1:18420')
    assert.deepStrictEqual(request.data, {
      jsonrpc: '2.0', method: 'get_tx_block', params: { txid: TXID }, id: 1
    })
    assert.ok(request.options.timeout > 0)
  })

  it('passes a null miss through unchanged', async function () {
    axios.post = async () => ({ data: { jsonrpc: '2.0', id: 1, result: null } })

    const result = await makeController().get_tx_block({ txid: TXID })

    assert.strictEqual(result, null)
  })

  it('passes stale sync metadata through unchanged', async function () {
    const stale = {
      block_hash: BLOCK_HASH,
      block_height: 80,
      sync: { committed_height: 81, committed_hash: 'd'.repeat(64) }
    }
    axios.post = async () => ({ data: { jsonrpc: '2.0', id: 1, result: stale } })

    const result = await makeController().get_tx_block({ txid: TXID })

    assert.strictEqual(result, stale)
    assert.strictEqual(result.sync, stale.sync)
  })

  it('maps an unhealthy tracker transport failure to the existing internal error type', async function () {
    const transportError = new Error('connect ECONNREFUSED 127.0.0.1:18420')
    transportError.code = 'ECONNREFUSED'
    axios.post = async () => { throw transportError }
    const originalError = console.error
    console.error = () => {}

    try {
      await assert.rejects(
        () => makeController().get_tx_block({ txid: TXID }),
        (err) => {
          assert.strictEqual(err.code, -32603)
          assert.strictEqual(err.message, 'Transaction block lookup failed')
          assert.ok(!err.message.includes('127.0.0.1'))
          return true
        }
      )
    } finally {
      console.error = originalError
    }
  })

  it('rejects a malformed txid with the existing invalid-params error type', async function () {
    await assert.rejects(
      () => makeController().get_tx_block({ txid: 'not-a-txid' }),
      (err) => {
        assert.strictEqual(err.code, -32602)
        assert.match(err.message, /64-hex-character/)
        return true
      }
    )
  })
})
