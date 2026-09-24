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

function registerExitPathTests({ assert, crash, observability, fakeProc, fs, path, __dirname }) {
  it('a broken logger cannot swallow the exit', function () {
    const proc = fakeProc()
    crash.installCrashHandlers({ proc })
    observability._resetObservability()
    proc.emit('uncaughtException', new Error('probe-no-sink'))
    assert.deepStrictEqual(proc.exits, [1])
  })

  // The handlers are worth nothing unless the entry point installs them, and
  // requiring api.js here would bind a port, so the wiring is read off the file.
  it('api.js installs them from the entry-point guard, not at module scope', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8')
    const guard = src.indexOf('require.main === module')
    const install = src.indexOf('installCrashHandlers()')
    assert.ok(guard > 0, 'entry-point guard present')
    assert.ok(install > guard, 'installCrashHandlers() is called inside the entry-point guard')
  })
}

module.exports = registerExitPathTests;
