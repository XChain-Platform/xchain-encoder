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

const API = '../../src/api.js'
const COINS = '../../src/coins'

// Boot api.js as its own process from an empty directory, so no local .env is read.
function bootApi({ childProcess, fs, os, path, dirname }, network, preload) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'encoder-boot-'))
  const env = Object.assign({}, process.env, {
    NETWORK: network,
    ENCODER_API_PORT: '0',
    ENCODER_INSTANCE_LOCK_FILE: path.join(cwd, 'instance.lock')
  })
  // The mocha bootstrap turns the console patch off; the child needs the real boot.
  delete env.XCHAIN_LOG_PATCH
  const args = []
  if (preload) {
    const file = path.join(cwd, 'preload.js')
    fs.writeFileSync(file, preload)
    args.push('-r', file)
  }
  args.push(path.join(dirname, API))
  const run = childProcess.spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 15000 })
  return { run, out: String(run.stdout || '') + String(run.stderr || '') }
}

// A boot throw counts only if it left the structured record and the exit code.
function assertCrashRecord(assert, { run, out }, text) {
  assert.strictEqual(run.signal, null, 'boot did not fail fast; it was still running at the timeout')
  assert.strictEqual(run.status, 1)
  const crash = out.split('\n').filter(l => l.includes('CRASH'))
  assert.strictEqual(crash.length, 1, 'expected one CRASH record, got:\n' + out)
  assert.ok(crash[0].includes('uncaughtException'), crash[0])
  assert.ok(crash[0].includes(text), crash[0])
}

function registerBootOrderTests(deps) {
  const { assert, fs, path } = deps

  it('an unknown NETWORK at module load leaves a CRASH record, not a bare stack dump', function () {
    this.timeout(20000)
    assertCrashRecord(assert, bootApi(deps, 'nope-regtest'), 'Unknown network')
  })

  it('a consensus-pin mismatch at module load leaves a CRASH record, not a bare stack dump', function () {
    this.timeout(20000)
    const coins = JSON.stringify(path.join(deps.dirname, COINS))
    const preload = 'require(' + coins + ').verifyConsensusPin = () => {' +
      " throw new Error('CONSENSUS CONFIG PIN MISMATCH for boot-order test') }\n"
    assertCrashRecord(assert, bootApi(deps, 'bitcoin-regtest', preload), 'CONSENSUS CONFIG PIN MISMATCH')
  })

  // Read off the file as well: the singleton is built at module load.
  it('api.js installs the handlers before it builds the singleton encoder', function () {
    const src = fs.readFileSync(path.join(deps.dirname, API), 'utf8')
    const install = src.indexOf('installCrashHandlers()')
    assert.ok(install > 0, 'installCrashHandlers() is called')
    assert.strictEqual(src.indexOf('installCrashHandlers()', install + 1), -1, 'installed exactly once')
    assert.ok(install < src.indexOf('new XChainEncoder('), 'installed before new XChainEncoder(')
  })
}

module.exports = registerBootOrderTests;
