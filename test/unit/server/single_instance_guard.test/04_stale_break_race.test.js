'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { acquireInstanceLock } = require('../../../../src/server/single_instance_guard')

describe('singleInstanceGuard stale-break ownership @regression', function () {
  let dir

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-lock-race-'))
  })

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not delete a fresh owner that published after the stale read', function () {
    const file = path.join(dir, 'race.lock')
    const deadPid = 999991
    const rivalPid = 424242
    const dead = JSON.stringify({ pid: deadPid, cmd: 'node old.js', token: 'dead' })
    const rival = JSON.stringify({ pid: rivalPid, cmd: 'node ./src/api.js', token: 'rival' })
    fs.writeFileSync(file, dead)

    assert.throws(() => acquireInstanceLock(file, {}, {
      isPidAlive(pid) {
        if (pid === deadPid) {
          fs.writeFileSync(file, rival)
          return false
        }
        return pid === rivalPid
      },
      describePid: () => 'node ./src/api.js'
    }), /Another xchain-encoder instance/)

    assert.strictEqual(fs.readFileSync(file, 'utf8'), rival)
  })

  it('cleans up its break mutex after replacing an unchanged stale lock', function () {
    const file = path.join(dir, 'stale.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: 999992, token: 'dead' }))
    const release = acquireInstanceLock(file, {}, { isPidAlive: () => false })
    assert.strictEqual(fs.existsSync(file + '.break'), false)
    release()
  })
})

describe('singleInstanceGuard stale-break ownership @regression', function () {
  let dir

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-lock-race-'))
  })

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not reclaim an old break mutex whose owner may only be paused', function () {
    const file = path.join(dir, 'abandoned.lock')
    const mutex = file + '.break'
    const stale = JSON.stringify({ pid: 999993, token: 'dead' })
    fs.writeFileSync(file, stale)
    fs.writeFileSync(mutex, 'abandoned')
    const old = new Date(Date.now() - 10000)
    fs.utimesSync(mutex, old, old)

    assert.throws(
      () => acquireInstanceLock(file, {}, { isPidAlive: () => false }),
      /Refusing to reclaim it automatically/
    )
    assert.strictEqual(fs.readFileSync(file, 'utf8'), stale)
    assert.strictEqual(fs.readFileSync(mutex, 'utf8'), 'abandoned')
  })

  it('does not publish a new owner while a stale breaker may still be active', function () {
    const file = path.join(dir, 'publish.lock')
    const mutex = file + '.break'
    fs.writeFileSync(mutex, 'paused-breaker')

    assert.throws(() => acquireInstanceLock(file), /Refusing to reclaim it automatically/)
    assert.strictEqual(fs.existsSync(file), false)
    assert.strictEqual(fs.readFileSync(mutex, 'utf8'), 'paused-breaker')
  })
})
