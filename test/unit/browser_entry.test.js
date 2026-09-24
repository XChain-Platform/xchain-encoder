// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The browserify entry behind dist/xchain_encoder.min.js: it attaches the
// encoder class to window and re-exports that same class.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const XChainEncoder = require('../../src/XChainEncoder')

const ENTRY = require.resolve('../../src/browser/index.js')
const PKG = path.join(__dirname, '..', '..', 'package.json')

// Re-run the entry body; the class module stays cached so identity holds across suites.
function loadEntry () {
  delete require.cache[ENTRY]
  return require(ENTRY)
}

describe('browser bundle entry (src/browser/index.js)', () => {
  afterEach(() => {
    delete global.window
    delete require.cache[ENTRY]
  })

  it('attaches the encoder class to window as the very class module', () => {
    global.window = {}
    loadEntry()
    assert.strictEqual(global.window.XChainEncoder, XChainEncoder)
  })

  it('exports the same class it attaches, not a copy or wrapper', () => {
    global.window = {}
    const exported = loadEntry()
    assert.strictEqual(typeof exported, 'function')
    assert.strictEqual(exported, XChainEncoder)
    assert.strictEqual(exported, global.window.XChainEncoder)
  })

  it('is browser-only: requiring it with no window throws ReferenceError', () => {
    assert.strictEqual(typeof global.window, 'undefined')
    assert.throws(() => loadEntry(), (err) => err instanceof ReferenceError && /window/.test(err.message))
  })

  it('is the file both bundle scripts name as their browserify entry', () => {
    const { scripts } = JSON.parse(fs.readFileSync(PKG, 'utf8'))
    for (const name of ['build', 'build:dev']) {
      assert.match(scripts[name], /browserify src\/browser\/index\.js /, `${name} bundles a different entry`)
    }
  })
})
