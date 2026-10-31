'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const axios = require('axios')
const BlockchainConnector = require('../../../src/build/blockchain_connector')

function transportError (code = 'ECONNABORTED') {
  const err = new Error(code === 'ECONNABORTED' ? 'timeout of 30000ms exceeded' : 'connection failed')
  err.code = code
  err.isAxiosError = true
  err.config = { auth: { username: 'rpcuser', password: 'rpcpass' } }
  return err
}

function answeredError () {
  const err = new Error('Request failed with status code 500')
  err.code = 'ERR_BAD_RESPONSE'
  err.isAxiosError = true
  err.response = {
    status: 500,
    data: { error: { code: -32603, message: 'Insufficient data or no feerate found' } }
  }
  return err
}

function warmConnector (chain) {
  const connector = new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
  Object.defineProperty(connector, '_chainNameCache', { value: chain, writable: true })
  connector.assertNodeTier = async () => {}
  return connector
}

function controllerOver (connector, network) {
  const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')
  return createJsonRpcController({ encoder: { connector }, NETWORK: network })
}

function installDeadNodeStub (calls, makeError) {
  axios.post = async (url, data) => {
    calls.push(data.method)
    if (data.method === 'estimatesmartfee') throw makeError()
    return { data: { result: { relayfee: 0.001 } } }
  }
}

describe('estimate_fee with a warm non-regtest connector and the coin node down', function () {
  let originalPost
  beforeEach(function () { originalPost = axios.post })
  afterEach(function () { axios.post = originalPost })

  for (const [chain, network] of [['main', 'bitcoin-mainnet'], ['test', 'bitcoin-testnet']]) {
    it(`returns NODE_UNREACHABLE after one ${chain} node call`, async function () {
      const calls = []
      const connector = warmConnector(chain)
      installDeadNodeStub(calls, transportError)

      await assert.rejects(controllerOver(connector, network).estimate_fee(), err => {
        assert.strictEqual(err.code, -32010)
        assert.strictEqual(err.data && err.data.reason, 'NODE_UNREACHABLE')
        assert.ok(!/127\.0\.0\.1|rpcpass|[a-z][a-z0-9+.-]*:\/\//i.test(err.message))
        return true
      })
      assert.deepStrictEqual(calls, ['estimatesmartfee'])
    })
  }

  for (const chain of ['main', 'test']) {
    for (const code of ['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET']) {
      it(`types an estimatesmartfee ${code} failure on ${chain}`, async function () {
        const calls = []
        const connector = warmConnector(chain)
        installDeadNodeStub(calls, () => transportError(code))

        await assert.rejects(connector.getFeePerKilobyte(6), err => {
          assert.strictEqual(err.operational, true)
          assert.strictEqual(err.xchainCode, 'NODE_UNREACHABLE')
          return true
        })
        assert.deepStrictEqual(calls, ['estimatesmartfee'])
      })
    }
  }

  it('keeps an answered estimatesmartfee error on the testnet relay fallback', async function () {
    const calls = []
    const connector = warmConnector('test')
    axios.post = async (url, data) => {
      calls.push(data.method)
      if (data.method === 'estimatesmartfee') throw answeredError()
      if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.001 } } }
      return { data: { result: {} } }
    }

    assert.strictEqual(await connector.getFeePerKilobyte(6), 0.01)
    assert.deepStrictEqual(calls, ['estimatesmartfee', 'getnetworkinfo'])
  })
})
