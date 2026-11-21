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
function bootEnv({ fs, os, path }, network, port) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'encoder-boot-'))
  const lockFile = path.join(cwd, 'instance.lock')
  const env = Object.assign({}, process.env, {
    NETWORK: network,
    ENCODER_API_PORT: port,
    ENCODER_INSTANCE_LOCK_FILE: lockFile
  })
  // The mocha bootstrap turns the console patch off; the child needs the real boot.
  delete env.XCHAIN_LOG_PATCH
  return { cwd, env, lockFile }
}

// Boot a healthy encoder on an OS-chosen port and stop it once it reports listening.
function bootUntilListening({ childProcess, fs, os, path, dirname }) {
  const { cwd, env } = bootEnv({ fs, os, path }, 'bitcoin-regtest', '0')
  const child = childProcess.spawn(process.execPath, [path.join(dirname, API)], { cwd, env })
  return new Promise((resolve, reject) => {
    let out = ''
    const ceiling = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('no listening line:\n' + out)) }, 25000)
    const onData = (chunk) => {
      out += String(chunk)
      if (/API listening on port \S+/.test(out)) child.kill('SIGTERM')
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', () => { clearTimeout(ceiling); resolve(out) })
  })
}

function bootApi({ childProcess, fs, os, path, dirname }, network, preload, port = '0') {
  const { cwd, env, lockFile } = bootEnv({ fs, os, path }, network, port)
  const args = []
  if (preload) {
    const file = path.join(cwd, 'preload.js')
    fs.writeFileSync(file, preload)
    args.push('-r', file)
  }
  args.push(path.join(dirname, API))
  const run = childProcess.spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 15000 })
  return { run, lockFile, out: String(run.stdout || '') + String(run.stderr || '') }
}

function registerListenTests(deps) {
  const { assert, net } = deps

  it('fails with one crash record and no listening line when the port is occupied', async function () {
    this.timeout(20000)
    const blocker = net.createServer()
    await new Promise((resolve, reject) => blocker.listen(0, resolve).once('error', reject))
    try {
      const result = bootApi(deps, 'bitcoin-regtest', null, String(blocker.address().port))
      assertCrashRecord(assert, result, 'EADDRINUSE')
      assert.ok(!result.out.includes('API listening'), result.out)
      assert.ok(!deps.fs.existsSync(result.lockFile), 'the instance lock outlived the failed bind')
    } finally {
      await new Promise(resolve => blocker.close(resolve))
    }
  })

  it('logs the port it actually bound when the bind succeeds', async function () {
    this.timeout(30000)
    const out = await bootUntilListening(deps)
    assert.match(out, /API listening on port [1-9]\d*\b/, out)
    assert.ok(!out.includes('port undefined'), out)
  })

  for (const port of ['not-a-port', '70000']) {
    it('refuses invalid ENCODER_API_PORT=' + port + ' before listening', function () {
      const result = bootApi(deps, 'bitcoin-regtest', null, port)
      assertCrashRecord(assert, result, 'ENCODER_API_PORT')
      assert.ok(!result.out.includes('API listening'), result.out)
    })
  }
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

  registerListenTests(deps)
}

module.exports = registerBootOrderTests;
