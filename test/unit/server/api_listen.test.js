'use strict'

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
const { EventEmitter } = require('events')
const { getLogger } = require('../../../src/observability')
const { DEFAULT_API_PORT, resolveApiPort, listenOrCrash } = require('../../../src/server/api_listen')

describe('encoder API port resolution', function () {
  it('uses the documented default when ENCODER_API_PORT is unset or empty', function () {
    assert.strictEqual(DEFAULT_API_PORT, 3000)
    assert.strictEqual(resolveApiPort(undefined), 3000)
    assert.strictEqual(resolveApiPort(''), 3000)
  })

  it('accepts a decimal port from 0 to 65535', function () {
    assert.strictEqual(resolveApiPort('0'), 0)
    assert.strictEqual(resolveApiPort('3002'), 3002)
    assert.strictEqual(resolveApiPort('65535'), 65535)
  })

  it('refuses a value that is not a whole port number', function () {
    for (const bad of ['abc', '-1', '3000.5', ' 3000', '0x10', '65536', '99999999999999999999']) {
      assert.throws(() => resolveApiPort(bad), /ENCODER_API_PORT must be a decimal integer/, bad)
    }
  })
})

describe('encoder API listen callback', function () {
  function fakeApp() {
    const app = { calls: [] }
    app.listen = (port, cb) => {
      const server = new EventEmitter()
      server.address = () => ({ port: 4321 })
      app.calls.push({ port, cb, server })
      return server
    }
    return app
  }

  it('rethrows a bind error instead of reporting success', function () {
    const app = fakeApp()
    listenOrCrash(app, 3000)
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    assert.throws(() => app.calls[0].cb(err), (e) => e === err)
  })

  it('reports the port the server actually bound', function () {
    const app = fakeApp()
    const logger = getLogger()
    const lines = []
    const original = logger.info
    logger.info = (line) => lines.push(line)
    try {
      listenOrCrash(app, 0)
      app.calls[0].cb()
    } finally {
      logger.info = original
    }
    assert.deepStrictEqual(lines, ['API listening on port 4321'])
  })
})
