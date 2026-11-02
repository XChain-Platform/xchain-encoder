'use strict'

const assert = require('assert')
const { createServeReadiness } = require('../../../../src/api/serve_readiness')

function readiness(profile, status) {
  const encoder = {
    trackerProfile: profile,
    maxUtxoTrackerLagBlocks: 2,
    connector: { nodeTierOk: true, assertNodeTier: async () => {} },
    utxoTrackerConnector: { getSyncStatus: async () => status }
  }
  return createServeReadiness({ encoder, readMaintenanceWindow: async () => null })
}

describe('serve readiness under UTXO_TRACKER_PROFILE=remote @regression', function () {
  it('fails closed when a synced tracker omits numeric lag', async function () {
    const result = await readiness('remote', { synced: true })()
    assert.strictEqual(result.tracker_reachable, true)
    assert.strictEqual(result.tracker_lag, null)
    assert.strictEqual(result.tracker_synced, false)
  })

  it('keeps the default profile fail-open behavior for a missing lag', async function () {
    const result = await readiness('default', { synced: true })()
    assert.strictEqual(result.tracker_synced, true)
  })

  it('reports a fully attested remote tracker ready', async function () {
    const result = await readiness('remote', { synced: true, lag: 0, mempool_ready: true })()
    assert.strictEqual(result.tracker_synced, true)
  })
})
