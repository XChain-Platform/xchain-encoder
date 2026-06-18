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
const BlockchainConnector = require('../../src/BlockchainConnector')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConnector () {
  return new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
}

// Capture and restore axios.post between tests
let originalPost

beforeEach(() => {
  originalPost = axios.post
})

afterEach(() => {
  axios.post = originalPost
})

function stubAxiosPost (response) {
  axios.post = async () => response
}

function stubAxiosPostThrow (err) {
  axios.post = async () => { throw err }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────────────────────

describe('BlockchainConnector constructor', () => {
  it('builds the correct URL from host and port', () => {
    const c = new BlockchainConnector('myhost', 9999, 'u', 'p')
    assert.strictEqual(c.url, 'http://myhost:9999')
  })

  it('stores rpcUser and rpcPassword', () => {
    const c = new BlockchainConnector('h', 1234, 'alice', 'secret')
    assert.strictEqual(c.rpcUser, 'alice')
    assert.strictEqual(c.rpcPassword, 'secret')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getNetworkInfo
// ─────────────────────────────────────────────────────────────────────────────

describe('BlockchainConnector.getNetworkInfo()', () => {
  it('sends the correct JSON-RPC method', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { version: 220000, subversion: '/Satoshi:22.0.0/' } } }
    }

    const c = makeConnector()
    await c.getNetworkInfo()
    assert.strictEqual(capturedPayload.method, 'getnetworkinfo')
    assert.strictEqual(capturedPayload.jsonrpc, '2.0')
    assert.strictEqual(capturedPayload.id, 1)
  })

  it('passes auth credentials to axios', async () => {
    let capturedOptions
    axios.post = async (url, data, options) => {
      capturedOptions = options
      return { data: { result: { version: 1 } } }
    }

    const c = makeConnector()
    await c.getNetworkInfo()
    assert.strictEqual(capturedOptions.auth.username, 'rpcuser')
    assert.strictEqual(capturedOptions.auth.password, 'rpcpass')
  })

  it('returns the result object on success', async () => {
    stubAxiosPost({ data: { result: { version: 220000, subversion: '/Satoshi:22.0.0/' } } })
    const c = makeConnector()
    const info = await c.getNetworkInfo()
    assert.strictEqual(info.version, 220000)
    assert.strictEqual(info.subversion, '/Satoshi:22.0.0/')
  })

  it('throws when result is missing from response', async () => {
    stubAxiosPost({ data: { result: null } })
    const c = makeConnector()
    await assert.rejects(
      () => c.getNetworkInfo(),
      /Error in network request/
    )
  })

  it('wraps axios transport errors', async () => {
    stubAxiosPostThrow(new Error('ECONNREFUSED'))
    const c = makeConnector()
    await assert.rejects(
      () => c.getNetworkInfo(),
      /Error in network request.*ECONNREFUSED/
    )
  })

  it('sets a timeout on the request', async () => {
    let capturedOptions
    axios.post = async (url, data, options) => {
      capturedOptions = options
      return { data: { result: { version: 1 } } }
    }
    const c = makeConnector()
    await c.getNetworkInfo()
    assert.ok(typeof capturedOptions.timeout === 'number' && capturedOptions.timeout > 0,
      'timeout must be a positive number')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isRegtest
// ─────────────────────────────────────────────────────────────────────────────

describe('BlockchainConnector.isRegtest()', () => {
  it('sends getblockchaininfo method', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { chain: 'regtest' } } }
    }
    const c = makeConnector()
    await c.isRegtest()
    assert.strictEqual(capturedPayload.method, 'getblockchaininfo')
  })

  it('returns true when chain is "regtest"', async () => {
    stubAxiosPost({ data: { result: { chain: 'regtest' } } })
    const c = makeConnector()
    assert.strictEqual(await c.isRegtest(), true)
  })

  it('returns false when chain is "main"', async () => {
    stubAxiosPost({ data: { result: { chain: 'main' } } })
    const c = makeConnector()
    assert.strictEqual(await c.isRegtest(), false)
  })

  it('returns false when chain is "test"', async () => {
    stubAxiosPost({ data: { result: { chain: 'test' } } })
    const c = makeConnector()
    assert.strictEqual(await c.isRegtest(), false)
  })

  it('throws when result is missing', async () => {
    stubAxiosPost({ data: { result: null } })
    const c = makeConnector()
    await assert.rejects(
      () => c.isRegtest(),
      /Error in network request/
    )
  })

  it('throws when result has no chain property', async () => {
    stubAxiosPost({ data: { result: {} } })
    const c = makeConnector()
    await assert.rejects(
      () => c.isRegtest(),
      /Error in network request/
    )
  })

  it('wraps transport errors', async () => {
    stubAxiosPostThrow(new Error('timeout of 30000ms exceeded'))
    const c = makeConnector()
    await assert.rejects(
      () => c.isRegtest(),
      /Error in network request.*timeout/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getTransactionHex
// ─────────────────────────────────────────────────────────────────────────────

describe('BlockchainConnector.getTransactionHex()', () => {
  const TXID = 'a'.repeat(64)
  const HEX = '0100000001' + '0'.repeat(100)

  it('sends getrawtransaction with correct txid and hexFormat=true', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { hex: HEX } } }
    }
    const c = makeConnector()
    await c.getTransactionHex(TXID)
    assert.strictEqual(capturedPayload.method, 'getrawtransaction')
    assert.deepStrictEqual(capturedPayload.params, [TXID, true])
  })

  it('passes hexFormat=false when requested', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { hex: HEX } } }
    }
    const c = makeConnector()
    await c.getTransactionHex(TXID, false)
    assert.deepStrictEqual(capturedPayload.params, [TXID, false])
  })

  it('returns the hex string on success', async () => {
    stubAxiosPost({ data: { result: { hex: HEX } } })
    const c = makeConnector()
    const result = await c.getTransactionHex(TXID)
    assert.strictEqual(result, HEX)
  })

  it('throws "not found" message when error.code is -5', async () => {
    stubAxiosPost({ data: { error: { code: -5, message: 'No such mempool or blockchain transaction' } } })
    const c = makeConnector()
    await assert.rejects(
      () => c.getTransactionHex(TXID),
      /not found.*txindex/
    )
  })

  it('includes the txid in the "not found" error message', async () => {
    stubAxiosPost({ data: { error: { code: -5, message: 'tx not found' } } })
    const c = makeConnector()
    await assert.rejects(
      () => c.getTransactionHex(TXID),
      new RegExp(TXID.slice(0, 8))
    )
  })

  it('throws generic error when result is missing and error is not -5', async () => {
    stubAxiosPost({ data: { result: null, error: null } })
    const c = makeConnector()
    await assert.rejects(
      () => c.getTransactionHex(TXID),
      /Error getting transaction hex/
    )
  })

  it('rethrows transport errors directly', async () => {
    stubAxiosPostThrow(new Error('Network failure'))
    const c = makeConnector()
    await assert.rejects(
      () => c.getTransactionHex(TXID),
      /Network failure/
    )
  })

  it('sends auth credentials', async () => {
    let capturedOptions
    axios.post = async (url, data, options) => {
      capturedOptions = options
      return { data: { result: { hex: HEX } } }
    }
    const c = makeConnector()
    await c.getTransactionHex(TXID)
    assert.strictEqual(capturedOptions.auth.username, 'rpcuser')
    assert.strictEqual(capturedOptions.auth.password, 'rpcpass')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// sendRawTransaction
// ─────────────────────────────────────────────────────────────────────────────

describe('BlockchainConnector.sendRawTransaction()', () => {
  const TX_HEX = '0100000001' + '0'.repeat(60) + 'ffffffff'
  const TXID_RESULT = 'b'.repeat(64)

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

// ─────────────────────────────────────────────────────────────────────────────
// getFeePerKilobyte
// ─────────────────────────────────────────────────────────────────────────────

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  it('sends estimatesmartfee with the blocksNumber param', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { feerate: 0.00005 } } }
    }
    const c = makeConnector()
    await c.getFeePerKilobyte(6)
    assert.strictEqual(capturedPayload.method, 'estimatesmartfee')
    assert.deepStrictEqual(capturedPayload.params, [6])
  })

  it('returns feerate when present', async () => {
    stubAxiosPost({ data: { result: { feerate: 0.00012345 } } })
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(3)
    assert.strictEqual(feerate, 0.00012345)
  })

  it('falls back to regtest default when feerate is missing and chain is regtest', async () => {
    // First call: estimatesmartfee → no feerate
    // Second call: isRegtest → regtest
    let callCount = 0
    axios.post = async (url, data) => {
      callCount++
      if (callCount === 1) {
        // estimatesmartfee returned no feerate
        return { data: { result: {} } }
      }
      // getblockchaininfo for isRegtest
      return { data: { result: { chain: 'regtest' } } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(1)
    assert.strictEqual(feerate, 0.00001000)
  })

  it('throws when feerate is missing and chain is not regtest', async () => {
    let callCount = 0
    axios.post = async (url, data) => {
      callCount++
      if (callCount === 1) {
        return { data: { result: {} } }
      }
      return { data: { result: { chain: 'main' } } }
    }
    const c = makeConnector()
    await assert.rejects(
      () => c.getFeePerKilobyte(1),
      /Error getting smart fee from node/
    )
  })

  it('rethrows transport errors', async () => {
    stubAxiosPostThrow(new Error('Connection refused'))
    const c = makeConnector()
    await assert.rejects(
      () => c.getFeePerKilobyte(1),
      /Connection refused/
    )
  })

  it('throws when result is entirely missing', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) return { data: { result: null } }
      return { data: { result: { chain: 'main' } } }
    }
    const c = makeConnector()
    await assert.rejects(
      () => c.getFeePerKilobyte(1),
      /Error getting smart fee from node/
    )
  })
})
