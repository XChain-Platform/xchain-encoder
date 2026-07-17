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
// sendRawTransaction regtest-gated maxfeerate retry (mirrors
// xchain-e2e-test/src/BlockchainConnector.js broadcastTx)
// ─────────────────────────────────────────────────────────────────────────────

describe('BlockchainConnector.sendRawTransaction() maxfeerate retry', () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// getFeePerKilobyte
// ─────────────────────────────────────────────────────────────────────────────

describe('BlockchainConnector.getFeePerKilobyte()', () => {
  // getFeePerKilobyte now consults isRegtest() FIRST (getblockchaininfo): on regtest
  // it returns the relayfee floor and never calls estimatesmartfee; only non-regtest
  // nodes reach the estimatesmartfee path. These tests therefore stub the chain.
  it('sends estimatesmartfee with the blocksNumber param (non-regtest)', async () => {
    let capturedFeePayload
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      if (data.method === 'estimatesmartfee') { capturedFeePayload = data; return { data: { result: { feerate: 0.00005 } } } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    await c.getFeePerKilobyte(6)
    assert.strictEqual(capturedFeePayload.method, 'estimatesmartfee')
    assert.deepStrictEqual(capturedFeePayload.params, [6])
  })

  it('returns feerate when present (non-regtest)', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      return { data: { result: { feerate: 0.00012345 } } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(3)
    assert.strictEqual(feerate, 0.00012345)
  })

  it('uses the relayfee floor on regtest and never consults estimatesmartfee', async () => {
    // Regression for the deep-regtest fee-inflation bug: on regtest, even when
    // estimatesmartfee WOULD return a (large) value, the connector must ignore it
    // and use the node's relayfee floor. We assert estimatesmartfee is never sent.
    let smartFeeCalled = false
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'regtest' } } }
      if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.00001000 } } }
      if (data.method === 'estimatesmartfee') { smartFeeCalled = true; return { data: { result: { feerate: 0.1386 } } } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(1)
    assert.strictEqual(feerate, 0.00001000)
    assert.strictEqual(smartFeeCalled, false, 'estimatesmartfee must not be consulted on regtest')
  })

  it('falls back to the regtest default when relayfee is unavailable', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'regtest' } } }
      if (data.method === 'getnetworkinfo') return { data: { result: {} } }
      return { data: { result: {} } }
    }
    const c = makeConnector()
    const feerate = await c.getFeePerKilobyte(1)
    assert.strictEqual(feerate, 0.00001000)
  })

  it('throws when feerate is missing and chain is not regtest', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      return { data: { result: {} } }
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

  it('throws when result is entirely missing (non-regtest)', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'main' } } }
      return { data: { result: null } }
    }
    const c = makeConnector()
    await assert.rejects(
      () => c.getFeePerKilobyte(1),
      /Error getting smart fee from node/
    )
  })
})

// Behavioral lock: every RPC call passes auth:{username,password} to axios, and
// axios attaches that config to the thrown error. Logging or re-throwing the raw
// error serializes the node RPC password into the encoder logs. Drive a failing
// getTransactionHex and assert the password never reaches console.error and is
// scrubbed from the re-thrown error. FAKE_RPC_PASSWORD is a test sentinel.
describe('BlockchainConnector RPC-credential log sanitization', () => {
  it('does not leak the RPC password when an axios call fails', async () => {
    const util = require('util')
    const FAKE_RPC_PASSWORD = 'FAKEPASS_must_never_be_logged_9c3f'

    const err = new Error('Request failed with status code 401')
    err.code = 'ERR_BAD_REQUEST'
    err.config = {
      auth: { username: 'rpcuser', password: FAKE_RPC_PASSWORD },
      headers: { Authorization: 'Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') }
    }
    err.request = { _header: 'Authorization: Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') }
    err.response = { status: 401, data: 'unauthorized', config: err.config }

    const c = new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', FAKE_RPC_PASSWORD)
    stubAxiosPostThrow(err)

    const originalError = console.error
    const logs = []
    console.error = (...args) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 8 }))).join(' '))
    }

    let thrown
    try {
      await c.getTransactionHex('deadbeef')
    } catch (e) {
      thrown = e
    } finally {
      console.error = originalError
    }

    const combined = logs.join('\n')
    assert.ok(thrown, 'the failing RPC should propagate an error')
    assert.ok(!combined.includes(FAKE_RPC_PASSWORD),
      'the RPC password must never appear in connector error logs (got: ' + combined + ')')
    assert.strictEqual(thrown.config && thrown.config.auth, undefined,
      'the re-thrown error must have its config.auth scrubbed')
  })
})
