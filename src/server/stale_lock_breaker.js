'use strict'

const fs = require('fs')
const { getLogger } = require('../observability')
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
function orphanedMutex(seen, waitedOut) {
  if (seen.text === '') return waitedOut
  let record
  try { record = JSON.parse(seen.text) } catch (err) { return false }
  if (!record || typeof record !== 'object') return false
  const pid = record.pid
  if (!Number.isInteger(pid) || pid <= 0) return false
  return pid === process.pid || !isPidAlive(pid)
}

// Read the mutex with its inode, or null when it is gone.
function readMutex(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      return { ino: fs.fstatSync(fd).ino, text: fs.readFileSync(fd, 'utf8') }
    } finally { fs.closeSync(fd) }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Move the orphan aside atomically, then confirm what moved is the file that
// was judged. If a contender replaced it in between, put that one back so its
// owner keeps the mutex. Returns whether the name is now free to take.
function reclaimOrphan(file, seen, token) {
  const aside = file + '.' + process.pid + '.' + token.slice(0, 8) + '.orphan'
  try { fs.renameSync(file, aside) } catch (err) {
    if (err.code === 'ENOENT') return true
    throw err
  }
  let moved = null
  try { moved = readMutex(aside) } catch (err) { /* judged below as a mismatch */ }
  const same = moved !== null && moved.ino === seen.ino && moved.text === seen.text
  if (!same) {
    try { fs.linkSync(aside, file) } catch (err) { /* a newer owner already holds the name */ }
  }
  try { fs.unlinkSync(aside) } catch (err) { /* already gone */ }
  if (same) {
    const why = seen.text === ''
      ? 'left empty by a writer that died mid-create'
      : 'its owner pid ' + JSON.parse(seen.text).pid + ' is gone or was an earlier life of this pid'
    logger.warn('staleLockBreaker: reclaimed an orphaned stale-break mutex at ' + file + ' (' + why + ')')
  }
  return same
}

// One pass of the wait: take the mutex, or judge the current holder.
// `state` carries the empty file first seen, so emptiness is timed per inode.
function tryBreakMutex(file, record, token, state, attempt) {
  try {
    const fd = fs.openSync(file, 'wx')
    try { fs.writeSync(fd, record) } finally { fs.closeSync(fd) }
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
  if (orphanedMutex(seen, waitedOut) && reclaimOrphan(file, seen, token)) return false
  sleepSync(MUTEX_WAIT_MS)
  return false
}

// Returns the record written, which release compares before unlinking.
function acquireBreakMutex(file, token) {
  const record = JSON.stringify({ pid: process.pid, token })
  const state = { emptyIno: null, emptySince: 0 }
  // One pass past the wait, so an empty orphan judged on the last pass is
  // reclaimed and taken rather than refused.
  for (let attempt = 0; attempt <= MUTEX_WAIT_PASSES; attempt++) {
    if (tryBreakMutex(file, record, token, state, attempt)) return record
  }
  throw new Error(
    'The xchain-encoder instance-lock stale-break mutex stayed busy at ' + file +
    '. Refusing to reclaim it automatically because its owner may only be paused. ' +
    'After confirming no encoder is starting, remove this mutex and retry.'
  )
}

function releaseBreakMutex(file, record) {
  try {
    if (fs.readFileSync(file, 'utf8') === record) fs.unlinkSync(file)
  } catch (err) { /* already gone */ }
}

function withStaleBreakMutex(file, token, action) {
  const mutex = file + '.break'
  const record = acquireBreakMutex(mutex, token)
  try {
    return action()
  } finally {
    releaseBreakMutex(mutex, record)
  }
}

function breakStaleLock(file, staleText, token, pass) {
  withStaleBreakMutex(file, token, () => {
    let current = null
    try { current = fs.readFileSync(file, 'utf8') } catch (err) { /* another breaker won */ }
    if (current !== null && current === staleText) {
      try { fs.unlinkSync(file) } catch (err) { /* the former owner released it */ }
    }
  })
  if (pass >= BREAK_PASSES) {
    throw new Error(
      'Another xchain-encoder instance keeps re-taking the instance lock ' + file +
      ' faster than this one can. Stop the other instance, or set ' +
      'ENCODER_INSTANCE_LOCK_FILE to isolate intentionally separate deployments.'
    )
  }
}

module.exports = { breakStaleLock, withStaleBreakMutex }
