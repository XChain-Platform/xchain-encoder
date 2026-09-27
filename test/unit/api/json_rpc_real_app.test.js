'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const http = require('http')
const bitcoin = require('bitcoinjs-lib')

const API_PATH = require.resolve('../../../src/api.js')
const JSON_RPC_METHODS_PATH = require.resolve('../../../src/api/json_rpc_methods.js')
const API_KEY_ENV = ['API', 'KEY'].join('_')

function rawTransaction () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 1), 0)
  tx.addOutput(Buffer.from([bitcoin.opcodes.OP_RETURN]), 0)
  return tx.toHex()
}

function postRpc (server, id, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

let api
let server
let cachedApi
let cachedJsonRpcMethods

async function loadRealApp () {
  const dotenv = require('dotenv')
  const maintenance = require('../../../src/server/maintenance_window')
  cachedApi = require.cache[API_PATH]
  cachedJsonRpcMethods = require.cache[JSON_RPC_METHODS_PATH]
  const originalDotenvConfig = dotenv.config
  const originalReadMaintenanceWindow = maintenance.readMaintenanceWindow
  const priorNetwork = process.env.NETWORK
  const priorApiKey = process.env[API_KEY_ENV]
  dotenv.config = () => ({ parsed: {} })
  maintenance.readMaintenanceWindow = async () => null
  process.env.NETWORK = 'bitcoin-regtest'
  delete process.env[API_KEY_ENV]
  delete require.cache[API_PATH]
  delete require.cache[JSON_RPC_METHODS_PATH]
  try {
    api = require(API_PATH)
  } finally {
    dotenv.config = originalDotenvConfig
    maintenance.readMaintenanceWindow = originalReadMaintenanceWindow
    if (priorNetwork === undefined) delete process.env.NETWORK
    else process.env.NETWORK = priorNetwork
    if (priorApiKey === undefined) delete process.env[API_KEY_ENV]
    else process.env[API_KEY_ENV] = priorApiKey
  }
  server = await new Promise(resolve => {
    const listener = api.app.listen(0, '127.0.0.1', () => resolve(listener))
  })
}

async function unloadRealApp () {
  if (server) await new Promise(resolve => server.close(resolve))
  delete require.cache[API_PATH]
  delete require.cache[JSON_RPC_METHODS_PATH]
  if (cachedApi) require.cache[API_PATH] = cachedApi
  if (cachedJsonRpcMethods) require.cache[JSON_RPC_METHODS_PATH] = cachedJsonRpcMethods
}

async function routeEachPublicHandler () {
  const calls = { broadcast: [], fees: [], cancel: [], health: 0 }
  const txHex = rawTransaction()
  const txid = 'a'.repeat(64)
  api.encoder.connector.sendRawTransaction = async hex => {
    calls.broadcast.push(hex)
    return txid
  }
  api.encoder.connector.getFeePerKilobyte = async target => {
    calls.fees.push(target)
    return target / 100000
  }
  api.encoder.createEnvelopeCancelTransaction = async params => {
    calls.cancel.push(params)
    return { psbt: { toHex: () => 'cancel-psbt' }, encoding: 'TAPROOT', cancel: true }
  }
  api.encoder.utxoTrackerConnector.getSyncStatus = async () => {
    calls.health += 1
    return { synced: true, lag: 0, halted: false, mempool_ready: true }
  }

  const broadcast = await postRpc(server, 1, 'broadcast_tx', { tx_hex: txHex })
  const fees = await postRpc(server, 2, 'estimate_fee', {})
  const cancelParams = { commitTxid: 'b'.repeat(64), destination: 'stubbed-backend' }
  const cancel = await postRpc(server, 3, 'create_envelope_cancel_tx', cancelParams)
  const ping = await postRpc(server, 4, 'ping', {})
  const health = await postRpc(server, 5, 'health', {})

  for (const response of [broadcast, fees, cancel, ping, health]) {
    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.body.jsonrpc, '2.0')
    assert.ok(!response.body.error, JSON.stringify(response.body.error))
  }
  assert.deepStrictEqual(broadcast.body.result, { txid })
  assert.deepStrictEqual(calls.broadcast, [txHex])
  assert.deepStrictEqual(calls.fees, [6, 3, 1])
  assert.deepStrictEqual(cancel.body.result, { psbt: 'cancel-psbt', encoding: 'TAPROOT', cancel: true })
  assert.deepStrictEqual(calls.cancel, [cancelParams])
  assert.strictEqual(ping.body.result.status, 'success')
  assert.deepStrictEqual(health.body.result, {
    tracker_reachable: true,
    tracker_synced: true,
    tracker_lag: 0,
    tracker_halted: false,
    tracker_mempool_ready: true,
    maintenance: null
  })
  assert.strictEqual(calls.health, 1)
}

describe('real JSON-RPC app HTTP dispatch', function () {
  before(loadRealApp)
  after(unloadRealApp)
  it('routes each public handler through src/api.js and the production router', routeEachPublicHandler)
})
