// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// A tracker answering HTTP 429 used to make the encoder log the whole
// AxiosError (its config, the ClientRequest and socket internals, the
// response headers), about 13 KB a record and two records per failed
// get_utxos. A one-minute burst of rate-limited calls then rotated away the
// container's entire log retention. Each failure must log one short line that
// still names the HTTP status, and the thrown error must reach the caller.

process.env.NETWORK = process.env.NETWORK || 'bitcoin-regtest'
process.env.NODE_URL = process.env.NODE_URL || '127.0.0.1'
process.env.NODE_PORT = process.env.NODE_PORT || '8332'
process.env.NODE_USER = process.env.NODE_USER || 'test'
process.env.NODE_PASSWORD = process.env.NODE_PASSWORD || 'test'

const assert = require('assert')
const axios = require('axios')
const { getLogger } = require('../../../src/observability')
const UtxoTracker = require('../../../src/build/utxo_tracker')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')
const { makeEncoder, getTestAddress } = require('../../integration/helpers/utxoFactory')
const actions = require('../../integration/helpers/actionFactory')

const NETWORK = 'bitcoin-regtest'
const address = getTestAddress(NETWORK)
const MAX_LINE_BYTES = 1024

// An AxiosError shaped like the one a rate-limited tracker reply produces,
// with the bulky request internals the old log line serialized.
function rateLimitedError () {
  const config = {
    url: 'http://127.0.0.1:3001',
    method: 'post',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'axios/1.x' },
    data: JSON.stringify({ jsonrpc: '2.0', method: 'get_sync_status', params: {}, id: 1 }),
    timeout: 15000,
    padding: 'p'.repeat(4000)
  }
  const request = {
    constructorName: 'ClientRequest',
    socket: { remoteAddress: '127.0.0.1', remotePort: 3001, bufferSize: 0, pending: 'q'.repeat(4000) },
    outputData: [{ data: 'POST / HTTP/1.1\r\nhost: 127.0.0.1:3001\r\n' + 'r'.repeat(3000) }]
  }
  const response = {
    status: 429,
    statusText: 'Too Many Requests',
    headers: { 'retry-after': '60', 'x-ratelimit-limit': '500', 'content-type': 'application/json' },
    data: { error: 'Too many requests' },
    config,
    request
  }
  return new axios.AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', config, request, response)
}

// Capture every logger.error line while fn runs; axios.post rejects with a 429.
async function capture (fn) {
  const logger = getLogger()
  const originalError = logger.error
  const originalPost = axios.post
  const lines = []
  const thrown = []
  logger.error = (msg, fields) => {
    lines.push(fields && Object.keys(fields).length ? `${msg} ${require('util').inspect(fields)}` : String(msg))
  }
  axios.post = async () => { const e = rateLimitedError(); thrown.push(e); throw e }
  try {
    let caught = null
    try { await fn() } catch (e) { caught = e }
    return { lines, thrown, caught }
  } finally {
    logger.error = originalError
    axios.post = originalPost
  }
}

function assertBounded (lines) {
  assert.ok(lines.length > 0, 'the failure should still be logged')
  for (const line of lines) {
    const bytes = Buffer.byteLength(line)
    assert.ok(bytes < MAX_LINE_BYTES, `log line is ${bytes} bytes: ${line.slice(0, 200)}`)
    assert.ok(/HTTP 429|rate limited/.test(line), `log line should name the 429: ${line}`)
    for (const word of ['ClientRequest', 'socket', 'headers', 'retry-after', 'padding', 'outputData']) {
      assert.ok(!line.includes(word), `log line should not carry the request dump (${word}): ${line.slice(0, 200)}`)
    }
  }
}

function trackerEncoder () {
  const encoder = makeEncoder(NETWORK)
  encoder.utxoTrackerConnector = new UtxoTracker('127.0.0.1', 3001)
  return encoder
}

describe('REG-36: a rate-limited tracker leaves one short log line per failure', () => {
  it('getUtxosFromAddress logs a bounded line and rethrows the original error', async () => {
    const tracker = new UtxoTracker('127.0.0.1', 3001)
    const { lines, thrown, caught } = await capture(() => tracker.getUtxosFromAddress(address))
    assertBounded(lines)
    assert.strictEqual(lines.length, 1)
    assert.strictEqual(caught, thrown[0], 'the AxiosError itself should propagate')
    assert.strictEqual(caught.response.status, 429)
  })

  it('the sync-status gate logs a bounded line and rethrows the original error', async () => {
    const tracker = new UtxoTracker('127.0.0.1', 3001)
    const { lines, thrown, caught } = await capture(() => tracker.getTxBlock('a'.repeat(64)))
    assert.strictEqual(caught, thrown[0], 'the AxiosError itself should propagate')
    // getTxBlock reaches only the sync-status gate here; its own lookup is never sent.
    assert.strictEqual(thrown.length, 1)
    assertBounded(lines)
    assert.strictEqual(lines.length, 1)
  })

  it('the get_utxos RPC writes at most one bounded record and answers -32603', async () => {
    const controller = createJsonRpcController({ encoder: trackerEncoder(), NETWORK })
    const { lines, caught } = await capture(() => controller.get_utxos({ address }))
    assertBounded(lines)
    assert.strictEqual(lines.length, 1, `one failed get_utxos wrote ${lines.length} records`)
    assert.ok(caught, 'get_utxos should reject')
    assert.strictEqual(caught.code, -32603)
  })

  it('the create_tx RPC writes at most one bounded record and answers a tracker error', async () => {
    const controller = createJsonRpcController({ encoder: trackerEncoder(), NETWORK })
    const params = { pubkey: address, data: actions.makeSend().data, change: address, unconfirmed: true }
    const { lines, caught } = await capture(() => controller.create_tx(params))
    assertBounded(lines)
    assert.strictEqual(lines.length, 1, `one failed create_tx wrote ${lines.length} records`)
    assert.ok(caught, 'create_tx should reject')
    assert.strictEqual(caught.code, -32010)
    assert.strictEqual(caught.data && caught.data.reason, 'UTXO_TRACKER_ERROR')
  })
})
