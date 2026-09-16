/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Smoke Tests: xchain-encoder
 *
 * Fast health-check suite that verifies the encoder's core building blocks
 * are operational. No coin node, no network calls, no external services.
 *
 * Run: npm run smoke-test
 */

const assert = require('assert')
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const jsonRouter = require('express-json-rpc-router');
const http = require('http');

describe('S10: API Server Startup', () => {

  let server

  afterEach((done) => {
    if (server) {
      server.close(done)
      server = null
    } else {
      done()
    }
  })

  it('Express + JSON-RPC stack starts and responds to ping', (done) => {
    const app = express()
    app.use(helmet())
    app.use(bodyParser.json())
    app.use(cors())

    const jsonRpcController = {
      async ping () { return { status: 'success' } }
    }
    app.use(jsonRouter({ methods: jsonRpcController }))

    // Listen on port 0 to let the OS pick a free port
    server = app.listen(0, () => {
      const port = server.address().port
      const payload = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            assert.deepStrictEqual(parsed.result, { status: 'success' })
            done()
          } catch (err) {
            done(err)
          }
        })
      })
      req.on('error', done)
      req.write(payload)
      req.end()
    })
  })
})
