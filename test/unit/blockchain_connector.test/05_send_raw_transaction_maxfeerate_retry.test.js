// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const axios = require('axios')
const BlockchainConnector = require('../../../src/build/blockchain_connector')

function makeConnector () {
  return new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
}

function registerAxiosHooks () {
  let originalPost
  beforeEach(() => {
    originalPost = axios.post
  })
  afterEach(() => {
    axios.post = originalPost
  })
}

const TX_HEX = '0100000001' + '0'.repeat(60) + 'ffffffff'
const TXID_RESULT = 'c'.repeat(64)
const CAP_MSG = 'Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)'

// Stub a node: first sendrawtransaction rejects with the fee cap, a retry
// carrying params [hex, 0] succeeds; getblockchaininfo reports `chain`.
function stubCapNode (chain, capturedSends) {
  axios.post = async (url, data) => {
    if (data.method === 'getblockchaininfo') return { data: { result: { chain } } }
    if (data.method === 'sendrawtransaction') {
      capturedSends.push(data.params)
      if (data.params.length === 1) {
        const err = new Error('Request failed with status code 500')
        err.response = { data: { error: { code: -25, message: CAP_MSG } } }
        throw err
      }
      return { data: { result: TXID_RESULT } }
    }
    return { data: { result: {} } }
  }
}

// Mirrors xchain-e2e-test/src/BlockchainConnector.js broadcastTx.

describe('BlockchainConnector.sendRawTransaction() maxfeerate retry', () => {
  registerAxiosHooks()
  it('retries once with maxfeerate=0 on the fee-cap error when chain is regtest', async () => {
    const sends = []
    stubCapNode('regtest', sends)
    const c = makeConnector()
    const txid = await c.sendRawTransaction(TX_HEX)
    assert.strictEqual(txid, TXID_RESULT)
    assert.strictEqual(sends.length, 2)
    assert.deepStrictEqual(sends[0], [TX_HEX])
    assert.deepStrictEqual(sends[1], [TX_HEX, 0])
  })

  it('does NOT retry on the fee-cap error when chain is not regtest', async () => {
    const sends = []
    stubCapNode('main', sends)
    const c = makeConnector()
    await assert.rejects(() => c.sendRawTransaction(TX_HEX), /Fee exceeds maximum/)
    assert.strictEqual(sends.length, 1, 'no maxfeerate retry off regtest')
  })

  it('does NOT retry on regtest for non-fee-cap errors', async () => {
    const sends = []
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'regtest' } } }
      if (data.method === 'sendrawtransaction') {
        capturedPush(sends, data.params)
        const err = new Error('HTTP 500')
        err.response = { data: { error: { code: -26, message: 'bad-txns-inputs-missingorspent' } } }
        throw err
      }
      return { data: { result: {} } }
    }
    function capturedPush (arr, v) { arr.push(v) }
    const c = makeConnector()
    await assert.rejects(() => c.sendRawTransaction(TX_HEX), /bad-txns-inputs-missingorspent/)
    assert.strictEqual(sends.length, 1)
  })
})

describe('BlockchainConnector.sendRawTransaction() maxfeerate retry', () => {
  registerAxiosHooks()
  it('propagates the original fee-cap error when the chain check itself fails', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') throw new Error('Connection refused')
      const err = new Error('HTTP 500')
      err.response = { data: { error: { code: -25, message: CAP_MSG } } }
      throw err
    }
    const c = makeConnector()
    await assert.rejects(() => c.sendRawTransaction(TX_HEX), /Fee exceeds maximum/)
  })

  it('propagates the retry failure if the maxfeerate=0 retry is also rejected', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'regtest' } } }
      const err = new Error('HTTP 500')
      err.response = {
        data: {
          error: data.params && data.params.length === 2
            ? { code: -26, message: 'insufficient fee, rejecting replacement' }
            : { code: -25, message: CAP_MSG }
        }
      }
      throw err
    }
    const c = makeConnector()
    await assert.rejects(() => c.sendRawTransaction(TX_HEX), /insufficient fee/)
  })

  it('matches the bare "maxfeerate" wording variant', async () => {
    const sends = []
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'regtest' } } }
      if (data.method === 'sendrawtransaction') {
        sends.push(data.params)
        if (data.params.length === 1) {
          return { data: { error: { code: -25, message: 'max feerate exceeded: see maxfeerate' } } }
        }
        return { data: { result: TXID_RESULT } }
      }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    const txid = await c.sendRawTransaction(TX_HEX)
    assert.strictEqual(txid, TXID_RESULT)
    assert.strictEqual(sends.length, 2)
  })
})
