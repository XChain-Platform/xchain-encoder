// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const fs = require('fs')
const path = require('path')
const { getLogger } = require('../observability')
const { NO_HARDLINK_CODES } = require('./lock_file_protocol')
const logger = getLogger()

const BREAK_PASSES = 5
const MUTEX_WAIT_MS = 20
const MUTEX_WAIT_PASSES = 50

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// kill(pid, 0) probes existence without signalling; EPERM still means alive.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// The mutex is taken on EVERY boot (publication goes through it), so a writer
// that dies holding it (SIGKILL, OOM, a docker stop timeout inside the few-ms
// window) would wedge every later boot until an operator removed the file,
// and the file sits in the container's writable layer, which survives a
// restart. The mutex therefore records its owner's pid, and an orphan is
// reclaimed when that owner provably cannot still be using it:
//  - the recorded pid is dead;
//  - the recorded pid is this process, which holds no mutex while it waits,
//    so the record is from an earlier container life that reused our number;
//  - the file stayed empty, on the same inode, for the whole bounded wait: its
//    writer died between create and write, a window of microseconds.
// A live owner, or a record this code cannot read (such as the bare token an
// older encoder wrote), is still refused, because its owner may only be paused.
function orphanedMutex(seen, waitedOut, alive) {
  if (seen.text === '') return waitedOut
  let record
  try { record = JSON.parse(seen.text) } catch (err) { return false }
  if (!record || typeof record !== 'object') return false
  const pid = record.pid
  if (!Number.isInteger(pid) || pid <= 0) return false
  return pid === process.pid || !alive(pid)
}

// Read the mutex contents and identity from one open descriptor.
function readMutex(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const stat = fs.fstatSync(fd, { bigint: true })
      return { ino: stat.ino, ctimeNs: stat.ctimeNs, text: fs.readFileSync(fd, 'utf8') }
    } finally { fs.closeSync(fd) }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function claimSuffix(seen) {
  return seen.ino.toString() + '-' + seen.ctimeNs.toString()
}

// Claims for identities other than the current mutex can never become current
// again. A matching claim may have a live holder, so it is left to fail closed.
function sweepStaleClaims(file) {
  const dir = path.dirname(file)
  const prefix = path.basename(file) + '.reclaim-'
  let entries
  try { entries = fs.readdirSync(dir) } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    // Re-read for each deletion. A mutex may have changed identities since the
    // directory scan, and deleting its newly-created claim would re-open the
    // same double-reclaimer race this protocol closes.
    const current = readMutex(file)
    const keep = current === null ? null : prefix + claimSuffix(current)
    if (entry !== keep) {
      try { fs.unlinkSync(path.join(dir, entry)) } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
  }
}

// Publish a complete mutex record in one link operation. The fallback is kept
// for filesystems that do not support hard links.
function takeMutex(file, record, token) {
  const tmp = file + '.' + process.pid + '.' + token.slice(0, 8) + '.tmp'
  let tmpWritten = false
  try {
    const fd = fs.openSync(tmp, 'wx')
    try { fs.writeSync(fd, record) } finally { fs.closeSync(fd) }
    tmpWritten = true
    fs.linkSync(tmp, file)
  } catch (err) {
    if (!tmpWritten || !NO_HARDLINK_CODES.has(err.code)) throw err
    const fd = fs.openSync(file, 'wx')
    try { fs.writeSync(fd, record) } finally { fs.closeSync(fd) }
  } finally {
    if (tmpWritten) {
      try { fs.unlinkSync(tmp) } catch (err) { /* already gone */ }
    }
  }
}

// An identity-keyed exclusive claim serializes reclaimers. The mutex name is
// never moved, and only the exact inode, timestamp and record judged orphaned
// may be removed.
function reclaimOrphan(file, seen, token) {
  const claim = file + '.reclaim-' + claimSuffix(seen)
  let claimed = false
  try {
    const fd = fs.openSync(claim, 'wx')
    claimed = true
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, token })) } finally { fs.closeSync(fd) }
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
  try {
    const current = readMutex(file)
    if (current === null) return true
    const same = current.ino === seen.ino && current.ctimeNs === seen.ctimeNs && current.text === seen.text
    if (!same) return false
    try { fs.unlinkSync(file) } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const why = seen.text === ''
      ? 'left empty by a writer that died mid-create'
      : 'its owner pid ' + JSON.parse(seen.text).pid + ' is gone or was an earlier life of this pid'
    logger.warn('staleLockBreaker: reclaimed an orphaned stale-break mutex at ' + file + ' (' + why + ')')
    return true
  } finally {
    if (claimed) {
      try { fs.unlinkSync(claim) } catch (err) { /* already gone */ }
    }
  }
}

// One pass of the wait: take the mutex, or judge the current holder.
// `state` carries the empty file first seen, so emptiness is timed per inode.
function tryBreakMutex(file, record, token, state, attempt, deps) {
  sweepStaleClaims(file)
  try {
    takeMutex(file, record, token)
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  const seen = readMutex(file)
  if (seen === null) return false
  if (seen.text !== '' || state.emptyIno !== seen.ino) {
    state.emptyIno = seen.text === '' ? seen.ino : null
    state.emptySince = attempt
  }
  const waitedOut = attempt - state.emptySince >= MUTEX_WAIT_PASSES - 1
  if (orphanedMutex(seen, waitedOut, deps.isPidAlive) && reclaimOrphan(file, seen, token)) return false
  sleepSync(MUTEX_WAIT_MS)
  return false
}

// Returns the record written, which release compares before unlinking.
function acquireBreakMutex(file, token, deps) {
  const record = JSON.stringify({ pid: process.pid, token })
  const state = { emptyIno: null, emptySince: 0 }
  // One pass past the wait, so an empty orphan judged on the last pass is
  // reclaimed and taken rather than refused.
  for (let attempt = 0; attempt <= MUTEX_WAIT_PASSES; attempt++) {
    if (tryBreakMutex(file, record, token, state, attempt, deps)) return record
  }
  throw new Error(
    'The xchain-encoder instance-lock stale-break mutex stayed busy at ' + file +
    '. Refusing to reclaim it automatically because its owner may only be paused. ' +
    'After confirming no encoder is starting, remove this mutex and any matching .reclaim-* file, then retry.'
  )
}

function releaseBreakMutex(file, record) {
  try {
    if (fs.readFileSync(file, 'utf8') === record) fs.unlinkSync(file)
  } catch (err) { /* already gone */ }
}

function withStaleBreakMutex(file, token, action, deps = {}) {
  const mutex = file + '.break'
  const resolved = { isPidAlive: deps.isPidAlive || isPidAlive }
  const record = acquireBreakMutex(mutex, token, resolved)
  try {
    return action()
  } finally {
    releaseBreakMutex(mutex, record)
  }
}

function breakStaleLock(file, staleText, token, pass, deps) {
  withStaleBreakMutex(file, token, () => {
    let current = null
    try { current = fs.readFileSync(file, 'utf8') } catch (err) { /* another breaker won */ }
    if (current !== null && current === staleText) {
      try { fs.unlinkSync(file) } catch (err) { /* the former owner released it */ }
    }
  }, deps)
  if (pass >= BREAK_PASSES) {
    throw new Error(
      'Another xchain-encoder instance keeps re-taking the instance lock ' + file +
      ' faster than this one can. Stop the other instance, or set ' +
      'ENCODER_INSTANCE_LOCK_FILE to isolate intentionally separate deployments.'
    )
  }
}

module.exports = { breakStaleLock, withStaleBreakMutex }
