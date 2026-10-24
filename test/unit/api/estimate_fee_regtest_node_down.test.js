'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// A regtest fee quote whose coin node does not answer must fail on the first
// node timeout with a typed operational error. It must not retry the dead node
// once per tier (three node timeouts in a row) and then report a made-up
// default quote as success.

const assert = require('assert')
const BlockchainConnector = require('../../../src/build/blockchain_connector')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

function timeoutError () {
  const err = new Error('timeout of 30000ms exceeded')
  err.code = 'ECONNABORTED'
  return err
}

// A real connector on a regtest chain whose getnetworkinfo is stubbed. The
// stub rejects at once, so no test waits on a real timeout.
function regtestConnector (networkInfo, calls) {
  const connector = new BlockchainConnector('127.0.0.1', 18443, 'rpcuser', 'rpcpass')
  connector._chainNameCache = 'regtest'
  connector.assertNodeTier = async () => {}
  connector.getNetworkInfo = async () => {
    calls.push('getnetworkinfo')
    return networkInfo()
  }
  return connector
}

function controllerOver (connector) {
  return createJsonRpcController({ encoder: { connector }, NETWORK: 'bitcoin-regtest' })
}

describe('estimate_fee on regtest with the coin node down', function () {
  it('rejects with the operational node error after one node call', async function () {
    const calls = []
    const connector = regtestConnector(() => Promise.reject(timeoutError()), calls)
    const controller = controllerOver(connector)

    let result
    let failure
    try {
      result = await controller.estimate_fee()
    } catch (err) {
      failure = err
    }

    assert.strictEqual(result, undefined, 'a dead node must not yield a quote, got ' + JSON.stringify(result))
    assert.ok(failure, 'estimate_fee must reject')
    assert.strictEqual(failure.code, -32010)
    assert.strictEqual(failure.data && failure.data.reason, 'NODE_UNREACHABLE')
    assert.ok(!/timeout|127\.0\.0\.1|rpcpass/.test(failure.message), 'message stays credential and topology free')
    assert.deepStrictEqual(calls, ['getnetworkinfo'], 'fail fast: the dead node is asked once, not once per tier')
  })

  it('still quotes the node relayfee floor when the node answers', async function () {
    const calls = []
    const connector = regtestConnector(async () => ({ relayfee: 0.00002 }), calls)
    const controller = controllerOver(connector)

    assert.deepStrictEqual(await controller.estimate_fee(), { low: 2, medium: 2, high: 2 })
    assert.strictEqual(calls.length, 3)
  })
})

describe('regtest getFeePerKilobyte', function () {
  it('rethrows a node transport failure instead of inventing a default', async function () {
    const calls = []
    const connector = regtestConnector(() => Promise.reject(timeoutError()), calls)

    await assert.rejects(connector.getFeePerKilobyte(1), err => {
      assert.strictEqual(err.operational, true)
      assert.strictEqual(err.xchainCode, 'NODE_UNREACHABLE')
      return true
    })
    assert.deepStrictEqual(calls, ['getnetworkinfo'], 'the failed call is not retried through the recovery path')
  })

  it('keeps the conservative default when the node answers without a usable relayfee', async function () {
    for (const info of [{}, { relayfee: 0 }, { relayfee: 'x' }]) {
      const connector = regtestConnector(async () => info, [])
      assert.strictEqual(await connector.getFeePerKilobyte(1), 0.00001)
    }
  })
})
