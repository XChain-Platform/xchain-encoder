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
const fs = require('fs')
const path = require('path')
const util = require('util')
const { sanitizeRpcError, rpcErrorDetail } = require('../../../src/build/blockchain_connector/rpc_helpers')

const FAKE_RPC_PASSWORD = 'FAKEPASS_must_never_be_logged_10'

// Build each failure shape fresh, since sanitizeRpcError scrubs in place.
const CASES = {
  'HTTP 401 with a string body': () => {
    const err = new Error('Request failed with status code 401')
    err.config = {
      auth: { username: 'rpcuser', password: FAKE_RPC_PASSWORD },
      headers: { Authorization: 'Basic ' + Buffer.from('rpcuser:' + FAKE_RPC_PASSWORD).toString('base64') }
    }
    err.request = { _header: 'Authorization: Basic x' }
    err.response = { status: 401, data: 'unauthorized', config: err.config }
    return err
  },
  'HTTP 500 with a -28 JSON-RPC body': () => {
    const err = new Error('Request failed with status code 500')
    err.config = { auth: { username: 'rpcuser', password: FAKE_RPC_PASSWORD }, headers: {} }
    err.response = { status: 500, data: { error: { code: -28, message: 'Loading block index...' } } }
    return err
  },
  'HTTP 500 with a code-only JSON-RPC body': () => {
    const err = new Error('Request failed with status code 500')
    err.response = { status: 500, data: { error: { code: -8 } } }
    return err
  },
  'a transport failure with no response': () => new Error('socket hang up'),
  'a response with no status': () => {
    const err = new Error('odd')
    err.response = { data: 'x' }
    return err
  },
}

// Assert the credential scrub left nothing that util.inspect could print.
function assertScrubbed (err) {
  assert.strictEqual(err.config ? err.config.auth : undefined, undefined)
  assert.ok(!(err.config && err.config.headers && err.config.headers.Authorization))
  assert.strictEqual(err.request, undefined)
  if (err.response !== undefined) assert.deepStrictEqual(Object.keys(err.response), ['status'])
  assert.ok(!util.inspect(err, { depth: 8 }).includes(FAKE_RPC_PASSWORD))
}

describe('sanitizeRpcError() credential scrub', () => {
  for (const [label, make] of Object.entries(CASES)) {
    it(`scrubs ${label}`, () => {
      const err = make()
      assert.strictEqual(typeof sanitizeRpcError(err), 'string')
      assertScrubbed(err)
    })
  }
})

describe('sanitizeRpcError() parity with the xchain-decoder twin', function () {
  const DECODER = process.env.XCHAIN_DECODER_DIR || path.join(__dirname, '../../../../xchain-decoder')
  const TWIN = path.join(DECODER, 'src', 'chain', 'blockchain_connector', 'rpc_helpers.js')
  let twin

  before(function () {
    try {
      if (!fs.existsSync(TWIN)) throw new Error('not found at ' + TWIN)
      twin = require(TWIN)
    } catch (e) {
      if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
        throw new Error('xchain-decoder sanitizeRpcError twin unavailable but XCHAIN_REQUIRE_SIBLINGS=1: ' + e.message)
      }
      this.skip()
    }
  })

  for (const [label, make] of Object.entries(CASES)) {
    it(`scrubs the same fields and reads the same text for ${label}`, () => {
      const ours = make()
      const theirs = make()
      // This copy leaves the node's reason to rpcErrorDetail, read before the scrub.
      const detail = rpcErrorDetail(ours.response && ours.response.data)
      const ourText = sanitizeRpcError(ours) + detail
      const theirText = twin.sanitizeRpcError(theirs)
      assert.strictEqual(ourText, theirText)
      assertScrubbed(ours)
      assertScrubbed(theirs)
      assert.deepStrictEqual(ours.response, theirs.response)
    })
  }
})
