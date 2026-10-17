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
const { app, encoder } = require('../../../src/api')
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

describe('GET /status node-tier readiness', function () {
  let originalSyncStatus
  let originalMismatch

  beforeEach(function () {
    originalSyncStatus = encoder.utxoTrackerConnector.getSyncStatus
    originalMismatch = encoder.connector.nodeTierMismatch
    encoder.utxoTrackerConnector.getSyncStatus = async () => ({ synced: true, lag: 0 })
    delete encoder.connector.nodeTierMismatch
  })

  afterEach(function () {
    encoder.utxoTrackerConnector.getSyncStatus = originalSyncStatus
    if (originalMismatch === undefined) delete encoder.connector.nodeTierMismatch
    else encoder.connector.nodeTierMismatch = originalMismatch
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
  })
})
