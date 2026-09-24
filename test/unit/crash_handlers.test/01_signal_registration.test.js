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

function registerSignalTests({ assert, crash, fakeProc, lines, crashCount }) {
  it('an uncaught exception emits one CRASH record and exits non-zero', function () {
    const proc = fakeProc()
    crash.installCrashHandlers({ proc })

    proc.emit('uncaughtException', new Error('probe-uncaught-encoder'))

    assert.strictEqual(lines().length, 1)
    assert.ok(lines()[0].includes('kind=uncaughtException'), lines()[0])
    assert.ok(lines()[0].includes('probe-uncaught-encoder'), lines()[0])
    assert.ok(lines()[0].includes('[xchain-encoder]'), lines()[0])
    assert.deepStrictEqual(proc.exits, [1])
    assert.strictEqual(crashCount('uncaughtException'), 1)
  })

  it('an unhandled rejection emits CRASH and lets the process continue', function () {
    const proc = fakeProc()
    crash.installCrashHandlers({ proc })

    proc.emit('unhandledRejection', new Error('probe-rejection-encoder'))

    assert.strictEqual(lines().length, 1)
    assert.ok(lines()[0].includes('kind=unhandledRejection'), lines()[0])
    assert.deepStrictEqual(proc.exits, [], 'a stray promise does not by itself corrupt shared state')
    assert.strictEqual(crashCount('unhandledRejection'), 1)
  })

  it('a non-Error rejection reason still yields a readable record', function () {
    const proc = fakeProc()
    crash.installCrashHandlers({ proc })
    proc.emit('unhandledRejection', 'plain string reason')
    assert.ok(lines()[0].includes('plain string reason'), lines()[0])
  })
}

module.exports = registerSignalTests;
