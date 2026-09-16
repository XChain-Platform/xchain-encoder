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

function stubAxiosPost (response) {
  axios.post = async () => response
}

function stubAxiosPostThrow (err) {
  axios.post = async () => { throw err }
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
const TXID_RESULT = 'b'.repeat(64)

describe('BlockchainConnector.sendRawTransaction()', () => {
  registerAxiosHooks()
  it('sends sendrawtransaction with the tx hex as param', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: TXID_RESULT } }
    }
    const c = makeConnector()
    await c.sendRawTransaction(TX_HEX)
    assert.strictEqual(capturedPayload.method, 'sendrawtransaction')
    assert.deepStrictEqual(capturedPayload.params, [TX_HEX])
  })

  it('returns the txid on success', async () => {
    stubAxiosPost({ data: { result: TXID_RESULT } })
    const c = makeConnector()
    const txid = await c.sendRawTransaction(TX_HEX)
    assert.strictEqual(txid, TXID_RESULT)
  })

  it('throws when JSON-RPC response contains an error field', async () => {
    stubAxiosPost({ data: { error: { message: 'Transaction already in block chain' } } })
    const c = makeConnector()
    await assert.rejects(
      () => c.sendRawTransaction(TX_HEX),
      /Transaction already in block chain/
    )
  })
})

describe('BlockchainConnector.sendRawTransaction()', () => {
  registerAxiosHooks()
  it('uses error.message from JSON-RPC error when present', async () => {
    stubAxiosPost({ data: { error: { message: 'bad-txns-inputs-missingorspent', code: -25 } } })
    const c = makeConnector()
    await assert.rejects(
      () => c.sendRawTransaction(TX_HEX),
      /bad-txns-inputs-missingorspent/
    )
  })

  it('falls back to JSON.stringify when error has no message', async () => {
    stubAxiosPost({ data: { error: { code: -99 } } })
    const c = makeConnector()
    await assert.rejects(
      () => c.sendRawTransaction(TX_HEX),
      /-99/
    )
  })

  it('throws generic error when result is missing and no error', async () => {
    stubAxiosPost({ data: { result: null } })
    const c = makeConnector()
    await assert.rejects(
      () => c.sendRawTransaction(TX_HEX),
      /Error broadcasting transaction/
    )
  })

  it('surfaces bitcoind HTTP-500 error body when axios throws', async () => {
    // bitcoind returns HTTP 500 for rejected transactions with a JSON-RPC error body
    const rpcErr = new Error('Request failed with status code 500')
    rpcErr.response = {
      data: { error: { code: -26, message: 'dust' } }
    }
    stubAxiosPostThrow(rpcErr)
    const c = makeConnector()
    await assert.rejects(
      () => c.sendRawTransaction(TX_HEX),
      /dust/
    )
  })
})

describe('BlockchainConnector.sendRawTransaction()', () => {
  registerAxiosHooks()
  it('rethrows transport errors that have no response body', async () => {
    const netErr = new Error('socket hang up')
    stubAxiosPostThrow(netErr)
    const c = makeConnector()
    await assert.rejects(
      () => c.sendRawTransaction(TX_HEX),
      /socket hang up/
    )
  })

  it('uses the message from error.response.data.error when code is -26', async () => {
    const rpcErr = new Error('HTTP 500')
    rpcErr.response = {
      data: { error: { code: -26, message: 'non-mandatory-script-verify-flag' } }
    }
    stubAxiosPostThrow(rpcErr)
    const c = makeConnector()
    await assert.rejects(
      () => c.sendRawTransaction(TX_HEX),
      /non-mandatory-script-verify-flag/
    )
  })

  it('JSON.stringify fallback in HTTP-500 error body when error.message is absent', async () => {
    // Exercises the || JSON.stringify(body.error) branch on line 165:
    // body.error is truthy but body.error.message is absent/falsy.
    const rpcErr = new Error('HTTP 500')
    rpcErr.response = {
      data: { error: { code: -26 } } // no message field
    }
    stubAxiosPostThrow(rpcErr)
    const c = makeConnector()
    await assert.rejects(
      () => c.sendRawTransaction(TX_HEX),
      /-26/ // JSON.stringify includes the code
    )
  })
})
