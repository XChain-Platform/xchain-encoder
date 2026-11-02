'use strict'

// A tracker read the tracker refuses (its per-IP limiter answering 429) must
// leave a log line, not only tracker_reachable:false, so an encoder made
// unready by the limiter is traceable from its own log. These probes stub the
// tracker connector and inject the log sink and clock.

const assert = require('assert')
const { createServeReadiness } = require('../../../src/api/serve_readiness')

function refusal() {
  const err = new Error('Request failed with status code 429')
  err.response = { status: 429 }
  return err
}

function build(getSyncStatus, trackerTtlMs) {
  const clock = { t: 1000 }
  const lines = []
  const encoder = {
    trackerProfile: 'default',
    maxUtxoTrackerLagBlocks: 2,
    connector: { nodeTierOk: true, assertNodeTier: async () => {} },
    utxoTrackerConnector: { getSyncStatus }
  }
  const probe = createServeReadiness({
    encoder,
    readMaintenanceWindow: async () => null,
    now: () => clock.t,
    trackerTtlMs,
    log: line => lines.push(line)
  })
  return { probe, clock, lines }
}

describe('serve readiness logs a refused tracker read', function () {
  it('logs one warn line naming the 429 across several probes inside the TTL', async function () {
    const { probe, clock, lines } = build(async () => { throw refusal() }, 2000)
    for (let i = 0; i < 5; i++) {
      const r = await probe()
      assert.strictEqual(r.tracker_reachable, false)
      assert.strictEqual(r.tracker_synced, false)
      clock.t += 100
    }
    assert.strictEqual(lines.length, 1, 'lines: ' + JSON.stringify(lines))
    assert.match(lines[0], /tracker sync status read failed/)
    assert.match(lines[0], /rate limit/i)
    assert.match(lines[0], /Request failed with status code 429/)
  })

  it('folds a sustained outage into one count line per minute, then logs the recovery', async function () {
    let down = true
    const { probe, clock, lines } = build(async () => {
      if (down) throw refusal()
      return { synced: true, lag: 0, mempool_ready: true }
    }, 0)
    // A fresh read every 2 s for just over a minute: 31 failed reads.
    for (let i = 0; i <= 30; i++) {
      await probe()
      clock.t += 2000
    }
    assert.strictEqual(lines.length, 2, 'lines: ' + JSON.stringify(lines))
    assert.match(lines[1], /30 failed reads since the last line/)
    down = false
    assert.strictEqual((await probe()).tracker_reachable, true)
    assert.strictEqual(lines.length, 3)
    assert.match(lines[2], /recovered after 31 failed reads/)
  })

  it('logs nothing while the tracker answers', async function () {
    const { probe, clock, lines } = build(async () => ({ synced: true, lag: 0, mempool_ready: true }), 0)
    for (let i = 0; i < 3; i++) {
      assert.strictEqual((await probe()).tracker_reachable, true)
      clock.t += 2000
    }
    assert.deepStrictEqual(lines, [])
  })

  it('still answers when the log sink throws', async function () {
    const encoder = {
      trackerProfile: 'default',
      maxUtxoTrackerLagBlocks: 2,
      connector: { nodeTierOk: true, assertNodeTier: async () => {} },
      utxoTrackerConnector: { getSyncStatus: async () => { throw refusal() } }
    }
    const probe = createServeReadiness({
      encoder, readMaintenanceWindow: async () => null, trackerTtlMs: 0,
      log: () => { throw new Error('sink down') }
    })
    assert.strictEqual((await probe()).tracker_reachable, false)
  })
})
