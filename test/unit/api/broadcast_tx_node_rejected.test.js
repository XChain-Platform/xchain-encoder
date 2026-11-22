'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const axios = require('axios')
const bitcoin = require('bitcoinjs-lib')
const BlockchainConnector = require('../../../src/build/blockchain_connector')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

function txHex () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 1), 0)
  tx.addOutput(Buffer.from([bitcoin.opcodes.OP_RETURN]), 0)
  return tx.toHex()
}

function controllerFailing (err) {
  const encoder = { connector: { sendRawTransaction: async () => { throw err }, assertNodeTier: async () => {} } }
  return createJsonRpcController({ encoder, NETWORK: 'dogecoin-testnet' })
}

function nodeError (message, nodeCode) {
  const err = new Error(message)
  if (nodeCode !== undefined) err.nodeCode = nodeCode
  return err
}

async function rejection (controller) {
  try {
    await controller.broadcast_tx({ tx_hex: txHex() })
  } catch (e) {
    return e
  }
  throw new Error('expected broadcast_tx to reject')
}

describe('broadcast_tx node rejection codes', function () {
  let originalError
  beforeEach(() => { originalError = console.error; console.error = () => {} })
  afterEach(() => { console.error = originalError })

  it('answers a node rejection as -32010 NODE_REJECTED with the node code', async function () {
    const e = await rejection(controllerFailing(nodeError('min relay fee not met', -26)))
    assert.strictEqual(e.code, -32010)
    assert.deepStrictEqual(e.data, { reason: 'NODE_REJECTED', node_code: -26, node_reason: 'MIN_RELAY_FEE' })
    assert.match(e.message, /min relay fee not met/)
  })

  it('answers an already-known tx as TX_ALREADY_IN_CHAIN by node code', async function () {
    const e = await rejection(controllerFailing(nodeError('Transaction already in block chain', -27)))
    assert.strictEqual(e.code, -32010)
    assert.deepStrictEqual(e.data, { reason: 'TX_ALREADY_IN_CHAIN', node_code: -27, node_reason: 'TX_ALREADY_IN_CHAIN' })
  })

  it('answers a mempool duplicate as TX_ALREADY_IN_CHAIN by message', async function () {
    const e = await rejection(controllerFailing(nodeError('txn-already-known', -26)))
    assert.strictEqual(e.data.reason, 'TX_ALREADY_IN_CHAIN')
    assert.strictEqual(e.data.node_code, -26)
  })

  it('keeps a transport fault at -32603 with no data', async function () {
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8332'), { code: 'ECONNREFUSED' })
    const e = await rejection(controllerFailing(err))
    assert.strictEqual(e.code, -32603)
    assert.strictEqual(e.data, undefined)
    assert.ok(!/10\.0\.0\.5/.test(e.message))
  })

  it('keeps a node error without a numeric code at -32603', async function () {
    const e = await rejection(controllerFailing(nodeError('empty result')))
    assert.strictEqual(e.code, -32603)
  })

  it('removes arbitrary text adjacent to a recognized node reason', async function () {
    const e = await rejection(controllerFailing(nodeError('dust rpcpassword=example-secret', -26)))
    assert.strictEqual(e.message, 'dust')
    assert.strictEqual(e.data.node_reason, 'DUST')
    assert.ok(!e.message.includes('example-secret'))
  })
})

describe('broadcast_tx node rejection codes through the real connector', function () {
  let originalError
  let originalPost
  beforeEach(() => { originalPost = axios.post; originalError = console.error; console.error = () => {} })
  afterEach(() => { axios.post = originalPost; console.error = originalError })

  function realController () {
    const connector = new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
    return createJsonRpcController({ encoder: { connector }, NETWORK: 'dogecoin-testnet' })
  }

  it('propagates the node code from a node error body to -32010', async function () {
    axios.post = async () => ({ data: { error: { message: 'dust', code: -26 } } })
    const e = await rejection(realController())
    assert.strictEqual(e.code, -32010)
    assert.deepStrictEqual(e.data, { reason: 'NODE_REJECTED', node_code: -26, node_reason: 'DUST' })
  })

  it('propagates the node code from an HTTP 500 body', async function () {
    axios.post = async () => { throw Object.assign(new Error('status 500'), { response: { data: { error: { message: 'Transaction already in block chain', code: -27 } } } }) }
    const e = await rejection(realController())
    assert.strictEqual(e.data.reason, 'TX_ALREADY_IN_CHAIN')
    assert.strictEqual(e.data.node_code, -27)
  })

  it('keeps the encoder-written empty-result text for a node that answers nothing', async function () {
    axios.post = async () => ({ data: { result: null } })
    const e = await rejection(realController())
    assert.strictEqual(e.code, -32603)
    assert.strictEqual(e.message, 'Error broadcasting transaction: empty result')
  })

  it('keeps a transport fault at -32603', async function () {
    axios.post = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
    const e = await rejection(realController())
    assert.strictEqual(e.code, -32603)
  })
})
