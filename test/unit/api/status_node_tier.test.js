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

const assert = require('assert')
const { app, encoder, jsonRpcController } = require('../../../src/api')
const { assertNodeTier } = require('../../../src/build/blockchain_connector/node_queries')

async function statusResponse () {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/status`)
    return { code: response.status, body: await response.json() }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('assertNodeTier mismatch state', function () {
  it('records the mismatch reason on the connector before refusing the node', async function () {
    const connector = {
      consensusNetwork: 'testnet',
      chainName: async () => 'main'
    }

    await assert.rejects(assertNodeTier.call(connector), (error) => {
      assert.strictEqual(error.xchainCode, 'NODE_CHAIN_MISMATCH')
      return true
    })
    assert.strictEqual(
      connector.nodeTierMismatch,
      'node reports chain="main" (mainnet) but this encoder is configured for testnet'
    )
  })
})

// Connector fields the tier check reads or caches; each test starts from none of them set.
const TIER_FIELDS = ['nodeTierOk', 'nodeTierMismatch', 'nodeTierWarned', '_chainNameCache', 'consensusNetwork', 'chainName']

describe('GET /status node-tier readiness', function () {
  let originalSyncStatus
  let savedTier

  beforeEach(function () {
    originalSyncStatus = encoder.utxoTrackerConnector.getSyncStatus
    savedTier = {}
    for (const field of TIER_FIELDS) {
      savedTier[field] = Object.prototype.hasOwnProperty.call(encoder.connector, field)
        ? { own: true, value: encoder.connector[field] }
        : { own: false }
      delete encoder.connector[field]
    }
    encoder.utxoTrackerConnector.getSyncStatus = async () => ({ synced: true, lag: 0 })
    // A node on the configured tier unless a test says otherwise, so no test makes a real node RPC.
    encoder.connector.consensusNetwork = 'testnet'
    encoder.connector.chainName = async () => 'test'
  })

  afterEach(function () {
    encoder.utxoTrackerConnector.getSyncStatus = originalSyncStatus
    for (const field of TIER_FIELDS) {
      delete encoder.connector[field]
      if (savedTier[field].own) encoder.connector[field] = savedTier[field].value
    }
  })

  it('returns 503 and publishes a recorded node-tier mismatch reason', async function () {
    const reason = 'node reports chain="main" (mainnet) but this encoder is configured for testnet'
    encoder.connector.nodeTierMismatch = reason

    const response = await statusResponse()

    assert.strictEqual(response.code, 503)
    assert.strictEqual(response.body.status, 'unhealthy')
    assert.strictEqual(response.body.node_tier_mismatch, reason)
  })

  it('returns 200 with a null mismatch when no mismatch has been recorded', async function () {
    const response = await statusResponse()

    assert.strictEqual(response.code, 200)
    assert.strictEqual(response.body.status, 'healthy')
    assert.strictEqual(response.body.node_tier_mismatch, null)
    assert.strictEqual(response.body.node_tier_checked, true)
  })

  it('checks the tier itself and returns 503 for a wrong-network node no money call has touched', async function () {
    encoder.connector.chainName = async () => 'main'
    const reason = 'node reports chain="main" (mainnet) but this encoder is configured for testnet'

    const response = await statusResponse()

    assert.strictEqual(response.code, 503)
    assert.strictEqual(response.body.status, 'unhealthy')
    assert.strictEqual(response.body.node_tier_mismatch, reason)
    assert.strictEqual(response.body.node_tier_checked, true)
    const health = await jsonRpcController.health()
    assert.strictEqual(health.node_tier_mismatch, reason)
  })

  it('stays 200 but reads unchecked when the node chain cannot be read', async function () {
    encoder.connector.chainName = async () => { throw new Error('connect ECONNREFUSED') }

    const response = await statusResponse()

    assert.strictEqual(response.code, 200)
    assert.strictEqual(response.body.node_tier_mismatch, null)
    assert.strictEqual(response.body.node_tier_checked, false)
  })

  it('answers within the probe deadline when the node never replies', async function () {
    this.timeout(10000)
    encoder.connector.chainName = () => new Promise(() => {})
    const started = Date.now()

    const response = await statusResponse()

    assert.ok(Date.now() - started < 4500, `took ${Date.now() - started}ms`)
    assert.strictEqual(response.code, 200)
    assert.strictEqual(response.body.node_tier_checked, false)
  })
})
