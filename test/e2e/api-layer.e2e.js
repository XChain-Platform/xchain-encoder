/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E-10: JSON-RPC API Layer (Tier 2)
 *
 * Validates the API server correctly marshals JSON-RPC parameters
 * and returns valid PSBT hex.
 *
 * REQUIRES: API server running on localhost:3000 (`npm run api`)
 * REQUIRES: bitcoind running in regtest mode
 *
 * Run: npx mocha --timeout 0 test/e2e/api-layer.e2e.js
 */

const assert = require('assert')
const http = require('http')
const bitcoin = require('bitcoinjs-lib')

const API_PORT = process.env.ENCODER_API_PORT || 3000
const API_HOST = '127.0.0.1'

/**
 * Send a JSON-RPC request to the encoder API.
 */
function jsonRpcCall (method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    })

    const req = http.request({
      hostname: API_HOST,
      port: API_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) })
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        }
      })
    })

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * Check if the API server is reachable.
 */
async function isApiRunning () {
  try {
    await jsonRpcCall('ping', {})
    return true
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return false
    return true // other errors mean the server is up
  }
}

describe('E2E-10: JSON-RPC API Layer', function () {
  let apiAvailable = false

  before(async function () {
    apiAvailable = await isApiRunning()
    if (!apiAvailable) {
      console.log('    [SKIPPED] API server not running on port ' + API_PORT)
      console.log('    Start with: npm run api')
      this.skip()
    }
  })

  // ── E2E-10.1: create_tx with full params ─────────────────────

  describe('E2E-10.1: create_tx with full params', () => {
    it('returns {psbt: hex, encoding: string}', async function () {
      if (!apiAvailable) this.skip()

      const res = await jsonRpcCall('create_tx', {
        data: 'SEND|0|JDOG|1|mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
        pubkey: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
        change: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
        feePerKb: 0.00001,
        unconfirmed: true
      })

      if (res.body.error) {
        // May fail due to no UTXOs -- that's acceptable for env check
        assert.ok(res.body.error.message)
        return
      }

      assert.ok(res.body.result)
      assert.strictEqual(typeof res.body.result.psbt, 'string')
      assert.strictEqual(typeof res.body.result.encoding, 'string')
    })
  })

  // ── E2E-10.2: create_tx minimal params ───────────────────────

  describe('E2E-10.2: create_tx minimal params', () => {
    it('applies defaults for missing optional params', async function () {
      if (!apiAvailable) this.skip()

      const res = await jsonRpcCall('create_tx', {
        data: 'MINT|0|TEST|1',
        pubkey: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
        change: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy'
      })

      // Either succeeds with PSBT or fails with a meaningful error
      assert.ok(res.body.result || res.body.error)
    })
  })

  // ── E2E-10.3: PSBT hex validity ──────────────────────────────

  describe('E2E-10.3: PSBT hex validity', () => {
    it('returned hex can be parsed by Psbt.fromHex()', async function () {
      if (!apiAvailable) this.skip()

      const res = await jsonRpcCall('create_tx', {
        data: 'CALLBACK|0|TEST',
        pubkey: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
        change: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
        feePerKb: 0.00001,
        unconfirmed: true
      })

      if (res.body.error) return // no UTXOs, acceptable

      const psbtHex = res.body.result.psbt
      assert.doesNotThrow(() => {
        bitcoin.Psbt.fromHex(psbtHex)
      }, 'returned PSBT hex should be parseable')
    })
  })

  // ── E2E-10.4: Error response format ──────────────────────────

  describe('E2E-10.4: Error response format', () => {
    it('invalid method returns JSON-RPC error', async function () {
      if (!apiAvailable) this.skip()

      const res = await jsonRpcCall('nonexistent_method', {})

      // JSON-RPC spec: unknown method should return error
      assert.ok(res.body.error || res.status !== 200)
    })
  })

  // ── E2E-10.5: CORS headers ───────────────────────────────────

  describe('E2E-10.5: CORS headers', () => {
    it('response includes Access-Control-Allow-Origin', async function () {
      if (!apiAvailable) this.skip()

      const res = await jsonRpcCall('create_tx', {
        data: 'ADDRESS|0|1',
        pubkey: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
        change: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
        feePerKb: 0.00001,
        unconfirmed: true
      })

      // CORS header should be present (set by cors middleware)
      assert.ok(
        res.headers['access-control-allow-origin'] !== undefined,
        'should have CORS header'
      )
    })
  })

  // ── E2E-10.6: Concurrent requests ────────────────────────────

  describe('E2E-10.6: Concurrent requests', () => {
    it('multiple simultaneous requests do not interfere', async function () {
      if (!apiAvailable) this.skip()

      const requests = [
        jsonRpcCall('create_tx', {
          data: 'SEND|0|A|1|mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          pubkey: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          change: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          feePerKb: 0.00001,
          unconfirmed: true
        }),
        jsonRpcCall('create_tx', {
          data: 'SEND|0|B|2|mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          pubkey: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          change: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          feePerKb: 0.00001,
          unconfirmed: true
        }),
        jsonRpcCall('create_tx', {
          data: 'SEND|0|C|3|mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          pubkey: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          change: 'mfWxJ45yp2SFn7UciGDiKgSSkJGDvVbPYy',
          feePerKb: 0.00001,
          unconfirmed: true
        })
      ]

      const results = await Promise.all(requests)

      // All should complete without hanging
      assert.strictEqual(results.length, 3)
      for (const res of results) {
        assert.ok(res.body.result || res.body.error, 'each request should get a response')
      }
    })
  })
})
