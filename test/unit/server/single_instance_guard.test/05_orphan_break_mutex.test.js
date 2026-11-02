'use strict'

// A writer that dies while it holds the <lock>.break mutex (SIGKILL, OOM, or a
// docker stop timeout inside the publish or break window) would leave a file
// that every later boot refuses on, forever, even with no lock present. The
// mutex therefore carries its owner's pid: a dead or self-numbered owner, or a file
// still empty after the bounded wait, is reclaimed; a live owner is not.

const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { acquireInstanceLock } = require('../../../../src/server/single_instance_guard')

// A pid that existed a moment ago and has exited, so the liveness check is real.
function deadPid() {
  return childProcess.spawnSync(process.execPath, ['-e', '']).pid
}

describe('singleInstanceGuard orphaned break mutex @regression', function () {
  let dir

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-lock-orphan-'))
  })

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('boots past an empty mutex left with no lock present, and removes it', function () {
    const file = path.join(dir, 'empty.lock')
    fs.writeFileSync(file + '.break', '')

    const release = acquireInstanceLock(file)
    assert.strictEqual(fs.existsSync(file), true)
    assert.strictEqual(fs.existsSync(file + '.break'), false)
    release()
    assert.strictEqual(fs.existsSync(file), false)
  })

  it('boots past a mutex whose recorded owner has died', function () {
    const file = path.join(dir, 'dead.lock')
    fs.writeFileSync(file + '.break', JSON.stringify({ pid: deadPid(), token: 'dead-owner' }))

    const release = acquireInstanceLock(file)
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid)
    assert.strictEqual(fs.existsSync(file + '.break'), false)
    release()
  })

  it('boots past a mutex that names this process, left by an earlier container life', function () {
    const file = path.join(dir, 'self.lock')
    fs.writeFileSync(file + '.break', JSON.stringify({ pid: process.pid, token: 'previous-life' }))

    const release = acquireInstanceLock(file)
    assert.strictEqual(fs.existsSync(file + '.break'), false)
    release()
  })
})

describe('singleInstanceGuard orphaned break mutex bounds @regression', function () {
  let dir

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-lock-orphan-'))
  })

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reclaims an orphaned mutex while also breaking a dead owner lock', function () {
    const file = path.join(dir, 'both.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), cmd: 'node ./src/api.js', token: 'dead-lock' }))
    fs.writeFileSync(file + '.break', JSON.stringify({ pid: deadPid(), token: 'dead-breaker' }))

    const release = acquireInstanceLock(file)
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid)
    assert.strictEqual(fs.existsSync(file + '.break'), false)
    release()
  })

  it('still refuses a mutex whose recorded owner is alive, and leaves it in place', function () {
    const file = path.join(dir, 'live.lock')
    const live = JSON.stringify({ pid: process.ppid, token: 'paused-owner' })
    fs.writeFileSync(file + '.break', live)

    assert.throws(() => acquireInstanceLock(file), /Refusing to reclaim it automatically/)
    assert.strictEqual(fs.existsSync(file), false)
    assert.strictEqual(fs.readFileSync(file + '.break', 'utf8'), live)
  })

  it('leaves no reclaim side files behind in the lock directory', function () {
    const file = path.join(dir, 'tidy.lock')
    fs.writeFileSync(file + '.break', '')

    const release = acquireInstanceLock(file)
    release()
    assert.deepStrictEqual(fs.readdirSync(dir), [])
  })
})
