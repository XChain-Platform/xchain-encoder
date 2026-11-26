'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// get_tx_status against a real UtxoTracker with axios.post stubbed, so the count
// includes the readiness gate's hidden get_sync_status. The tracker enforces a
// per-IP budget (500 requests per 60 s by default) that every encoder caller
// shares, so each status answer must stay cheap and must not grow per call.

const assert = require('assert')
const axios = require('axios')
const UtxoTracker = require('../../../src/build/utxo_tracker')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

const TXID = 'a'.repeat(64)
const TRACKER_BUDGET = 500
const HEALTHY = { lag: 0, synced: true, mempool_ready: true, committed_height: 100, reorg_count: 0 }

// `syncs` answers get_sync_status in order (the last entry repeats); `block` answers get_tx_block.
function stubTracker ({ syncs = [HEALTHY], block = null } = {}) {
  const methods = []
  axios.post = async (url, data) => {
    methods.push(data.method)
    if (data.method === 'get_sync_status') {
      const reads = methods.filter((m) => m === 'get_sync_status').length
      return { data: { jsonrpc: '2.0', id: 1, result: syncs[Math.min(reads, syncs.length) - 1] } }
    }
    return { data: { jsonrpc: '2.0', id: 1, result: block } }
  }
  return methods
}

function makeController ({ nodeTip = 100 } = {}) {
  const encoder = {
    connector: {
      async getMempoolEntry () { return null },
      async getBlockCount () { return nodeTip }
    },
    utxoTrackerConnector: new UtxoTracker('127.0.0.1', 18420)
  }
  return createJsonRpcController({ encoder, NETWORK: 'bitcoin-regtest' })
}

function quietConsoleError () {
  let original
  beforeEach(function () { original = console.error; console.error = () => {} })
  afterEach(function () { console.error = original })
}

describe('get_tx_status tracker request budget', function () {
  let originalPost
  beforeEach(function () { originalPost = axios.post })
  afterEach(function () { axios.post = originalPost })
  quietConsoleError()

  it('answers unknown with one gated lookup and one confirming status read', async function () {
    const methods = stubTracker()
    assert.deepStrictEqual(await makeController().get_tx_status({ txid: TXID }), { status: 'unknown' })
    assert.deepStrictEqual(methods, ['get_sync_status', 'get_tx_block', 'get_sync_status'])
  })

  it('answers chain with one gated lookup', async function () {
    const methods = stubTracker({ block: { block_height: 90 } })
    assert.deepStrictEqual(await makeController().get_tx_status({ txid: TXID }), { status: 'chain' })
    assert.deepStrictEqual(methods, ['get_sync_status', 'get_tx_block'])
  })

  it('spends the same number of requests on every call', async function () {
    const methods = stubTracker()
    const controller = makeController()
    await controller.get_tx_status({ txid: TXID })
    const first = methods.length
    await controller.get_tx_status({ txid: TXID })
    assert.strictEqual(methods.length - first, first)
  })

  it('fits 80 unknown-txid polls inside one tracker budget window', async function () {
    const methods = stubTracker()
    const controller = makeController()
    for (let i = 0; i < 80; i++) {
      assert.deepStrictEqual(await controller.get_tx_status({ txid: TXID }), { status: 'unknown' })
    }
    assert.ok(methods.length <= 240, `80 polls cost ${methods.length} tracker requests`)
    assert.ok(methods.length < TRACKER_BUDGET)
  })
})

describe('get_tx_status tracker request budget on a stale tip', function () {
  let originalPost
  beforeEach(function () { originalPost = axios.post })
  afterEach(function () { axios.post = originalPost })
  quietConsoleError()

  it('refuses a miss behind the node tip in at most 4 requests and never answers unknown', async function () {
    const methods = stubTracker({ syncs: [{ ...HEALTHY, committed_height: 99, lag: 1 }] })
    await assert.rejects(() => makeController().get_tx_status({ txid: TXID }), (err) => err.code === -32603)
    assert.deepStrictEqual(methods, ['get_sync_status', 'get_tx_block', 'get_sync_status', 'get_tx_block'])
  })

  it('still reports a rollback seen by the confirming status read', async function () {
    stubTracker({ syncs: [HEALTHY, { ...HEALTHY, committed_height: 98 }] })
    await assert.rejects(() => makeController().get_tx_status({ txid: TXID }), (err) => err.code === -32603)
  })

  it('still refuses a lagging tracker at the readiness gate', async function () {
    const methods = stubTracker({ syncs: [{ lag: 10, synced: false }] })
    await assert.rejects(() => makeController().get_tx_status({ txid: TXID }), (err) => err.code === -32603)
    assert.deepStrictEqual(methods, ['get_sync_status'])
  })
})
