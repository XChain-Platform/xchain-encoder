'use strict'

const assert = require('assert')
const { createServeReadiness } = require('../../../../src/api/serve_readiness')

function build(getSyncStatus) {
  let clock = 1000
  const encoder = {
    trackerProfile: 'default',
    maxUtxoTrackerLagBlocks: 2,
    connector: { nodeTierOk: true, assertNodeTier: async () => {} },
    utxoTrackerConnector: { getSyncStatus }
  }
  const probe = createServeReadiness({ encoder, readMaintenanceWindow: async () => null, now: () => clock })
  return { probe, advance: ms => { clock += ms } }
}

describe('serve readiness tracker call budget @regression', function () {
  it('serves 500 concurrent and 500 sequential probes from a bounded number of tracker reads', async function () {
    let calls = 0
    const { probe } = build(async () => { calls++; return { synced: true, lag: 0, mempool_ready: true } })
    const concurrent = await Promise.all(Array.from({ length: 500 }, () => probe()))
    for (let i = 0; i < 500; i++) concurrent.push(await probe())
    assert.ok(calls <= 1, 'tracker reads: ' + calls)
    for (const r of concurrent) {
      assert.strictEqual(r.tracker_reachable, true)
      assert.strictEqual(r.tracker_synced, true)
    }
  })

  it('keeps a rate-limited tracker from flipping a probe inside the window, and re-reads after it', async function () {
    let calls = 0
    const { probe, advance } = build(async () => {
      calls++
      if (calls === 1) return { synced: true, lag: 0, mempool_ready: true }
      const err = new Error('Too many requests')
      err.response = { status: 429 }
      throw err
    })
    assert.strictEqual((await probe()).tracker_reachable, true)
    advance(500)
    const inside = await probe()
    assert.strictEqual(inside.tracker_reachable, true)
    assert.strictEqual(inside.tracker_synced, true)
    assert.strictEqual(calls, 1)
    advance(5000)
    const after = await probe()
    assert.strictEqual(calls, 2)
    assert.strictEqual(after.tracker_reachable, false)
    for (let i = 0; i < 50; i++) await probe()
    assert.strictEqual(calls, 2)
  })
})
