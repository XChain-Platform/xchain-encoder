'use strict'

const fs = require('fs')

const BREAK_PASSES = 5
const MUTEX_WAIT_MS = 20
const MUTEX_WAIT_PASSES = 50

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function acquireBreakMutex(file, token) {
  for (let attempt = 0; attempt < MUTEX_WAIT_PASSES; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx')
      try { fs.writeSync(fd, token) } finally { fs.closeSync(fd) }
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      sleepSync(MUTEX_WAIT_MS)
    }
  }
  throw new Error(
    'The xchain-encoder instance-lock stale-break mutex stayed busy at ' + file +
    '. Refusing to reclaim it automatically because its owner may only be paused. ' +
    'After confirming no encoder is starting, remove this mutex and retry.'
  )
}

function releaseBreakMutex(file, token) {
  try {
    if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file)
  } catch (err) { /* already gone */ }
}

function withStaleBreakMutex(file, token, action) {
  const mutex = file + '.break'
  acquireBreakMutex(mutex, token)
  try {
    return action()
  } finally {
    releaseBreakMutex(mutex, token)
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
