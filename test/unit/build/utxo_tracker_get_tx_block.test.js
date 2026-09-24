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
const HEALTHY_SYNC = { lag: 0, synced: true, mempool_ready: true }

function makeController () {
  const tracker = new UtxoTracker('127.0.0.1', 18420)
  return createJsonRpcController({
    encoder: { utxoTrackerConnector: tracker },
    NETWORK: 'dogecoin-testnet'
  })
}

function stubHealthyThenResult (result, requests) {
  axios.post = async (url, data, options) => {
    if (requests) requests.push({ url, data, options })
    if (data.method === 'get_sync_status') {
      return { data: { jsonrpc: '2.0', id: 1, result: HEALTHY_SYNC } }
    }
    return { data: { jsonrpc: '2.0', id: 1, result } }
  }
}

function restoreAxiosPostAfterEachTest () {
  let originalPost

  beforeEach(function () {
    originalPost = axios.post
  })

  afterEach(function () {
    axios.post = originalPost
  })
}

describe('get_tx_block tracker proxy results', function () {
  restoreAxiosPostAfterEachTest()

  it('returns a tracker hit and sends the exact lookup request', async function () {
    const expected = {
      block_hash: BLOCK_HASH,
      block_height: 123,
      sync: { committed_height: 125, committed_hash: 'c'.repeat(64) }
    }
    const requests = []
    stubHealthyThenResult(expected, requests)

    const controller = makeController()
    const result = await controller.get_tx_block({ txid: TXID })

    assert.strictEqual(result, expected)
    assert.strictEqual(Object.hasOwn(controller, 'get_tx_block'), true)
    assert.strictEqual(Object.keys(controller).includes('get_tx_block'), false)
    assert.strictEqual(requests.length, 2)
    assert.deepStrictEqual(requests[0].data, {
      jsonrpc: '2.0', method: 'get_sync_status', params: {}, id: 1
    })
    assert.strictEqual(requests[1].url, 'http://127.0.0.1:18420')
    assert.deepStrictEqual(requests[1].data, {
      jsonrpc: '2.0', method: 'get_tx_block', params: { txid: TXID }, id: 1
    })
    assert.ok(requests[1].options.timeout > 0)
  })

  it('passes a null miss through unchanged', async function () {
    stubHealthyThenResult(null)

    const result = await makeController().get_tx_block({ txid: TXID })

    assert.strictEqual(result, null)
  })

  it('passes stale sync metadata through unchanged', async function () {
    const stale = {
      block_hash: BLOCK_HASH,
      block_height: 80,
      sync: { committed_height: 81, committed_hash: 'd'.repeat(64) }
    }
    stubHealthyThenResult(stale)

    const result = await makeController().get_tx_block({ txid: TXID })

    assert.strictEqual(result, stale)
    assert.strictEqual(result.sync, stale.sync)
  })
})

describe('get_tx_block tracker proxy transport errors', function () {
  restoreAxiosPostAfterEachTest()

  it('maps an unhealthy tracker transport failure to the existing internal error type', async function () {
    const transportError = new Error('connect ECONNREFUSED 127.0.0.1:18420')
    transportError.code = 'ECONNREFUSED'
    axios.post = async (url, data) => {
      assert.strictEqual(url, 'http://127.0.0.1:18420')
      if (data.method === 'get_sync_status') {
        return { data: { jsonrpc: '2.0', id: 1, result: HEALTHY_SYNC } }
      }
      throw transportError
    }
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
})

describe('get_tx_block tracker proxy request errors', function () {
  restoreAxiosPostAfterEachTest()

  it('refuses an unhealthy tracker before requesting the transaction block', async function () {
    const methods = []
    axios.post = async (url, data) => {
      assert.strictEqual(url, 'http://127.0.0.1:18420')
      methods.push(data.method)
      return { data: { jsonrpc: '2.0', id: 1, result: { lag: 10, synced: false } } }
    }
    const originalError = console.error
    console.error = () => {}

    try {
      await assert.rejects(
        () => makeController().get_tx_block({ txid: TXID }),
        (err) => {
          assert.strictEqual(err.code, -32603)
          assert.match(err.message, /lagging by 10 blocks/)
          return true
        }
      )
      assert.deepStrictEqual(methods, ['get_sync_status'])
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
