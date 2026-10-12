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

const CONSTANTS_PATH = require.resolve('../../../src/build/blockchain_connector/constants.js')
const constants = require(CONSTANTS_PATH)

// Capture warnings on the shared logger so a discarded value is proven visible.
function captureWarnings (fn) {
  const warnings = []
  const original = constants.logger.warn
  constants.logger.warn = (msg) => { warnings.push(String(msg)) }
  try {
    return { value: fn(), warnings }
  } finally {
    constants.logger.warn = original
  }
}

// Load a fresh constants module under one NODE_RPC_TIMEOUT value and read RPC_TIMEOUT.
function rpcTimeoutUnder (raw) {
  const cached = require.cache[CONSTANTS_PATH]
  const saved = process.env.NODE_RPC_TIMEOUT
  if (raw === undefined) delete process.env.NODE_RPC_TIMEOUT
  else process.env.NODE_RPC_TIMEOUT = raw
  delete require.cache[CONSTANTS_PATH]
  try {
    return require(CONSTANTS_PATH).RPC_TIMEOUT
  } finally {
    if (saved === undefined) delete process.env.NODE_RPC_TIMEOUT
    else process.env.NODE_RPC_TIMEOUT = saved
    require.cache[CONSTANTS_PATH] = cached
  }
}

describe('NODE_RPC_TIMEOUT parsing', () => {
  describe('envInt', () => {
    it('returns the fallback without a warning when the value is unset', () => {
      const { value, warnings } = captureWarnings(() => constants.envInt(undefined, 30000, 'NODE_RPC_TIMEOUT'))
      assert.strictEqual(value, 30000)
      assert.strictEqual(warnings.length, 0)
    })

    for (const raw of ['', '   ', '30s', '0', '-5', 'abc', '1.5', 'NaN']) {
      it(`falls back to 30000 with a warning for ${JSON.stringify(raw)}`, () => {
        const { value, warnings } = captureWarnings(() => constants.envInt(raw, 30000, 'NODE_RPC_TIMEOUT'))
        assert.strictEqual(value, 30000)
        assert.strictEqual(warnings.length, 1)
        assert.match(warnings[0], /NODE_RPC_TIMEOUT/)
      })
    }

    it('accepts a clean positive integer, trimmed', () => {
      assert.strictEqual(constants.envInt('45000', 30000, 'NODE_RPC_TIMEOUT'), 45000)
      assert.strictEqual(constants.envInt(' 45000 ', 30000, 'NODE_RPC_TIMEOUT'), 45000)
      assert.strictEqual(constants.envInt('1', 30000, 'NODE_RPC_TIMEOUT'), 1)
    })
  })

  describe('RPC_TIMEOUT', () => {
    it('defaults to 30000 when NODE_RPC_TIMEOUT is unset', () => {
      assert.strictEqual(rpcTimeoutUnder(undefined), 30000)
    })

    it('keeps the 30000 default for an empty NODE_RPC_TIMEOUT instead of NaN', () => {
      assert.strictEqual(rpcTimeoutUnder(''), 30000)
    })

    it('keeps the 30000 default for a unit-suffixed NODE_RPC_TIMEOUT instead of truncating', () => {
      assert.strictEqual(rpcTimeoutUnder('30s'), 30000)
    })

    it('honours a valid NODE_RPC_TIMEOUT', () => {
      assert.strictEqual(rpcTimeoutUnder('45000'), 45000)
    })

    it('is always a positive integer, so axios always installs a timer', () => {
      for (const raw of [undefined, '', ' ', '30s', '0', '-1', 'x', '45000']) {
        const t = rpcTimeoutUnder(raw)
        assert.ok(Number.isInteger(t) && t >= 1, `${JSON.stringify(raw)} gave ${t}`)
      }
    })
  })
})
