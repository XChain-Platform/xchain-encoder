'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const axios = require('axios')
const BlockchainConnector = require('../../../src/build/blockchain_connector')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

const TXID = 'a'.repeat(64)

function controllerWith ({ mempoolEntry = null, block = null, nodeError, trackerError } = {}) {
  const calls = []
  const encoder = {
    connector: {
      async getMempoolEntry (txid) {
        calls.push(['mempool', txid])
        if (nodeError) throw nodeError
        return mempoolEntry
      }
    },
    utxoTrackerConnector: {
      async getTxBlock (txid) {
        calls.push(['chain', txid])
        if (trackerError) throw trackerError
        return block
      }
    }
  }
  return {
    calls,
    controller: createJsonRpcController({ encoder, NETWORK: 'dogecoin-testnet' })
  }
}

function connector () {
  return new BlockchainConnector('127.0.0.1', 22555, 'rpcuser', 'rpcpass')
}

describe('get_tx_status transaction location', function () {
  it('returns mempool and does not ask the tracker when getmempoolentry finds the txid', async function () {
    const { controller, calls } = controllerWith({ mempoolEntry: { vsize: 250 } })

    assert.deepStrictEqual(await controller.get_tx_status({ txid: TXID }), { status: 'mempool' })
    assert.deepStrictEqual(calls, [['mempool', TXID]])
  })

  it('returns chain after a mempool miss when get_tx_block finds the txid', async function () {
    const { controller, calls } = controllerWith({ block: { block_height: 123 } })

    assert.deepStrictEqual(await controller.get_tx_status({ txid: TXID }), { status: 'chain' })
    assert.deepStrictEqual(calls, [['mempool', TXID], ['chain', TXID]])
  })

  it('returns unknown only when both the mempool and chain lookups miss', async function () {
    const { controller, calls } = controllerWith()

    assert.deepStrictEqual(await controller.get_tx_status({ txid: TXID }), { status: 'unknown' })
    assert.deepStrictEqual(calls, [['mempool', TXID], ['chain', TXID]])
  })
})

describe('get_tx_status transaction location', function () {
  it('throws rather than returning unknown when the node lookup fails', async function () {
    const { controller, calls } = controllerWith({ nodeError: new Error('node warming up') })
    const originalError = console.error
    console.error = () => {}

    try {
      await assert.rejects(
        () => controller.get_tx_status({ txid: TXID }),
        (err) => err.code === -32603 && /node warming up/.test(err.message)
      )
      assert.deepStrictEqual(calls, [['mempool', TXID]])
    } finally {
      console.error = originalError
    }
  })

  it('throws rather than returning unknown when the tracker lookup fails', async function () {
    const { controller } = controllerWith({ trackerError: new Error('tracker unavailable') })
    const originalError = console.error
    console.error = () => {}

    try {
      await assert.rejects(
        () => controller.get_tx_status({ txid: TXID }),
        (err) => err.code === -32603 && /tracker unavailable/.test(err.message)
      )
    } finally {
      console.error = originalError
    }
  })

  it('rejects a malformed txid before either lookup', async function () {
    const { controller, calls } = controllerWith()

    await assert.rejects(
      () => controller.get_tx_status({ txid: 'not-a-txid' }),
      (err) => err.code === -32602 && /64-hex-character/.test(err.message)
    )
    assert.deepStrictEqual(calls, [])
  })
})

describe('BlockchainConnector getMempoolEntry', function () {
  let originalPost

  beforeEach(function () {
    originalPost = axios.post
  })

  afterEach(function () {
    axios.post = originalPost
  })

  it('sends getmempoolentry with the txid and returns the entry', async function () {
    const expected = { vsize: 250 }
    let request
    axios.post = async (url, data, options) => {
      request = { url, data, options }
      return { data: { result: expected } }
    }

    assert.strictEqual(await connector().getMempoolEntry(TXID), expected)
    assert.strictEqual(request.url, 'http://127.0.0.1:22555')
    assert.deepStrictEqual(request.data, {
      jsonrpc: '2.0', method: 'getmempoolentry', params: [TXID], id: 1
    })
    assert.deepStrictEqual(request.options.auth, { username: 'rpcuser', password: 'rpcpass' })
    assert.ok(request.options.timeout > 0)
  })

  it('returns null for an HTTP 200 RPC -5 mempool miss', async function () {
    axios.post = async () => ({ data: { error: { code: -5, message: 'Transaction not in mempool' } } })

    assert.strictEqual(await connector().getMempoolEntry(TXID), null)
  })

  it('returns null for an HTTP 500 RPC -5 mempool miss', async function () {
    axios.post = async () => {
      const err = new Error('Request failed with status code 500')
      err.response = { data: { error: { code: -5, message: 'Transaction not in mempool' } } }
      throw err
    }

    assert.strictEqual(await connector().getMempoolEntry(TXID), null)
  })
})

describe('BlockchainConnector getMempoolEntry', function () {
  let originalPost

  beforeEach(function () {
    originalPost = axios.post
  })

  afterEach(function () {
    axios.post = originalPost
  })

  it('throws an unexpected RPC error instead of treating it as absent', async function () {
    const originalError = console.error
    console.error = () => {}
    axios.post = async () => ({ data: { error: { code: -28, message: 'Loading block index' } } })

    try {
      await assert.rejects(() => connector().getMempoolEntry(TXID), /Loading block index/)
    } finally {
      console.error = originalError
    }
  })

  it('throws a transport error instead of treating it as absent', async function () {
    const originalError = console.error
    console.error = () => {}
    const transport = new Error('connect ECONNREFUSED 127.0.0.1:22555')
    transport.code = 'ECONNREFUSED'
    axios.post = async () => { throw transport }

    try {
      await assert.rejects(() => connector().getMempoolEntry(TXID), (err) => err === transport)
    } finally {
      console.error = originalError
    }
  })
})
