'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Pins the -32602 marker: JSON-RPC answers "fix your params" only for a
// ParamTypeError/ParamRangeError, so a bare TypeError or RangeError raised in
// src would silently become a logged, generic -32603 instead.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', '..', '..', 'src')
// Skip the hub-vendored trees: they are byte copies this repo may not edit
const VENDORED = ['coins', 'observability']

// Every .js file under src, recursively.
function sourceFiles (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

// The code part of one line: comment lines dropped, string literals blanked, a trailing // comment cut.
function codeOf (line) {
  if (/^\s*(\*|\/\*)/.test(line)) return ''
  return line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''").replace(/\/\/.*$/, '')
}

// Every src line that names TypeError or RangeError as a value, not only as `new X(`.
// (`instanceof X` and `extends X` only read the class, so they are allowed.)
function bareLines (text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    const code = codeOf(line).replace(/\b(instanceof|extends)\s+(TypeError|RangeError)\b/g, '')
    if (/\b(TypeError|RangeError)\b/.test(code)) hits.push(i + 1)
  })
  return hits
}

describe('caller-input errors carry the -32602 marker', () => {
  it('src raises no bare TypeError or RangeError, only the Param classes or a plain Error', () => {
    const files = sourceFiles(SRC).filter(f => !VENDORED.includes(path.relative(SRC, f).split(path.sep)[0]))
    assert.ok(files.length > 20, 'walked ' + files.length + ' files; src was not found')
    const bare = []
    for (const file of files) {
      for (const n of bareLines(fs.readFileSync(file, 'utf8'))) bare.push(path.relative(SRC, file) + ':' + n)
    }
    assert.deepStrictEqual(bare, [], 'raise ParamTypeError/ParamRangeError for a caller fault, plain Error for an internal one')
  })

  // A class handed to a helper that constructs it (refuse(TypeError, ...)) is a raise too.
  it('flags a class passed by reference, and ignores comments, strings and instanceof', () => {
    const probe = [
      "refuse(TypeError, 'x')",
      'pick(a, RangeError)',
      "// new TypeError('in a comment')",
      "throw new Error('RangeError: in a string')",
      'if (!(err instanceof TypeError)) throw err',
      "throw new TypeError('direct')"
    ].join('\n')
    assert.deepStrictEqual(bareLines(probe), [1, 2, 6])
  })
})
