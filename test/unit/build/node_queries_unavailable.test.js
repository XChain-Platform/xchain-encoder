'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// A coin node that does not answer at all (a timeout, a refused connection) is
// an outage the caller can retry, not an internal fault. The connector's node
// queries name it with the typed NODE_UNREACHABLE operational error, the same
// code estimate_fee already returns, so create_tx answers -32010 rather than a
// generic -32603 "Internal encoder error". A node that answers with its own RPC
// error body (-28 "Loading block index...") keeps that detail in the message.

const assert = require('assert')
const axios = require('axios')
const bitcoin = require('bitcoinjs-lib')
const BlockchainConnector = require('../../../src/build/blockchain_connector')
const XChainEncoder = require('../../../src/XChainEncoder')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

const NODE_HOST = '127.0.0.1'
const NODE_PORT = 18443
const RPC_PASSWORD = 'rpcpass_must_never_leak_5b1e'

function timeoutError () {
  const err = new Error('timeout of 30000ms exceeded')
  err.code = 'ECONNABORTED'
  err.isAxiosError = true
  err.config = { url: `http://${NODE_HOST}:${NODE_PORT}`, auth: { username: 'rpcuser', password: RPC_PASSWORD } }
  return err
}

function refusedError () {
  const err = new Error(`connect ECONNREFUSED ${NODE_HOST}:${NODE_PORT}`)
  err.code = 'ECONNREFUSED'
  err.isAxiosError = true
  err.config = { url: `http://${NODE_HOST}:${NODE_PORT}`, auth: { username: 'rpcuser', password: RPC_PASSWORD } }
  return err
}

function warmingError () {
  const err = new Error('Request failed with status code 500')
  err.code = 'ERR_BAD_RESPONSE'
  err.isAxiosError = true
  err.response = { status: 500, data: { error: { code: -28, message: 'Loading block index...' } } }
  err.config = { auth: { username: 'rpcuser', password: RPC_PASSWORD } }
  return err
}

function makeConnector () {
  return new BlockchainConnector(NODE_HOST, NODE_PORT, 'rpcuser', RPC_PASSWORD)
}

function assertNoTopology (message) {
  assert.ok(!message.includes(NODE_HOST), 'no host in ' + message)
  assert.ok(!message.includes(String(NODE_PORT)), 'no port in ' + message)
  assert.ok(!message.includes(RPC_PASSWORD), 'no credential in ' + message)
  assert.ok(!/[a-z][a-z0-9+.-]*:\/\//i.test(message), 'no URL in ' + message)
}

function assertNodeUnreachable (err) {
  assert.strictEqual(err.operational, true, 'a node outage is operational, got ' + err.message)
  assert.strictEqual(err.xchainCode, 'NODE_UNREACHABLE')
  assertNoTopology(err.message)
  return true
}

describe('node queries with the coin node unreachable', function () {
  let originalPost
  beforeEach(function () { originalPost = axios.post })
  afterEach(function () { axios.post = originalPost })

  for (const [name, makeError] of [['a timeout', timeoutError], ['a refused connection', refusedError]]) {
    it(`getNetworkInfo names ${name} as NODE_UNREACHABLE`, async function () {
      axios.post = async () => { throw makeError() }
      await assert.rejects(makeConnector().getNetworkInfo(), assertNodeUnreachable)
    })

    it(`chainName names ${name} as NODE_UNREACHABLE`, async function () {
      axios.post = async () => { throw makeError() }
      await assert.rejects(makeConnector().chainName(), assertNodeUnreachable)
    })

    it(`getBlockHash names ${name} as NODE_UNREACHABLE`, async function () {
      axios.post = async () => { throw makeError() }
      await assert.rejects(makeConnector().getBlockHash(0), assertNodeUnreachable)
    })
  }

  it('keeps the node RPC detail when the node answers with an error body', async function () {
    axios.post = async () => { throw warmingError() }
    await assert.rejects(makeConnector().getNetworkInfo(), (err) => {
      assert.notStrictEqual(err.operational, true, 'a node that answered is not an unreachable node')
      assert.ok(/^Error in network request/.test(err.message), err.message)
      assert.ok(err.message.includes('-28'), err.message)
      assert.ok(err.message.includes('Loading block index'), err.message)
      assert.ok(!err.message.includes(RPC_PASSWORD), err.message)
      return true
    })
  })

  it('keeps an HTTP-200 error body as a plain node error', async function () {
    axios.post = async () => ({ data: { result: null, error: { code: -28, message: 'Loading block index...' } } })
    await assert.rejects(makeConnector().getNetworkInfo(), (err) => {
      assert.notStrictEqual(err.operational, true)
      assert.ok(/^Error in network request/.test(err.message), err.message)
      assert.ok(err.message.includes('Loading block index'), err.message)
      return true
    })
  })
})

describe('create_tx with the coin node unreachable', function () {
  let originalPost
  beforeEach(function () { originalPost = axios.post })
  afterEach(function () { axios.post = originalPost })

  it('answers -32010 NODE_UNREACHABLE, not a generic -32603', async function () {
    const nodeCalls = []
    axios.post = async (url, data) => {
      nodeCalls.push(data && data.method)
      throw timeoutError()
    }
    const encoder = new XChainEncoder('bitcoin-regtest', NODE_HOST, String(NODE_PORT), 'rpcuser', RPC_PASSWORD, '', '')
    const controller = createJsonRpcController({ encoder, NETWORK: 'bitcoin-regtest' })

    const keyPair = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
    const p2pkh = bitcoin.payments.p2pkh({ pubkey: keyPair, network: bitcoin.networks.regtest })
    const params = {
      utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100000000, confirmations: 6, scriptPubKey: p2pkh.output.toString('hex') }],
      pubkey: p2pkh.address,
      customOutputs: [],
      data: 'ADDRESS|0|1|0|1|x',
      encoding: 'OP_RETURN',
      change: p2pkh.address,
      unconfirmed: false
    }

    let result
    let failure
    try {
      result = await controller.create_tx(params)
    } catch (err) {
      failure = err
    }

    assert.strictEqual(result, undefined, 'a dead node must not yield a build')
    assert.ok(failure, 'create_tx must reject')
    assert.strictEqual(failure.code, -32010, `expected -32010, got ${failure.code} ${failure.message}`)
    assert.strictEqual(failure.data && failure.data.reason, 'NODE_UNREACHABLE')
    assertNoTopology(failure.message)
    assert.ok(nodeCalls.length > 0, 'the build reached the stubbed node')
  })
})
