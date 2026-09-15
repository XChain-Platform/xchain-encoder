// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const {
  axios,
  installAxiosHooks,
  makeTracker,
  stubAxiosPost,
  stubAxiosPostThrow
} = require('./helpers/support')

describe('UtxoTracker.getSyncStatus()', () => {
  installAxiosHooks()

  it('sends get_sync_status JSON-RPC method', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { lag: 0, synced: true } } }
    }
    const t = makeTracker()
    await t.getSyncStatus()
    assert.strictEqual(capturedPayload.method, 'get_sync_status')
    assert.strictEqual(capturedPayload.jsonrpc, '2.0')
  })

  it('sends params as an empty object', async () => {
    let capturedPayload
    axios.post = async (url, data) => {
      capturedPayload = data
      return { data: { result: { lag: 0, synced: true } } }
    }
    const t = makeTracker()
    await t.getSyncStatus()
    assert.deepStrictEqual(capturedPayload.params, {})
  })

  it('returns the result object on success', async () => {
    const expectedResult = { committed_height: 500, tracker_height: 500, node_height: 500, lag: 0, synced: true }
    stubAxiosPost({ data: { result: expectedResult } })
    const t = makeTracker()
    const status = await t.getSyncStatus()
    assert.deepStrictEqual(status, expectedResult)
  })
})

describe('UtxoTracker.getSyncStatus()', () => {
  installAxiosHooks()

  it('throws when result is null', async () => {
    stubAxiosPost({ data: { result: null } })
    const t = makeTracker()
    await assert.rejects(
      () => t.getSyncStatus(),
      /Error getting sync status: empty result/
    )
  })

  it('throws when result is a non-object (string)', async () => {
    stubAxiosPost({ data: { result: 'bad' } })
    const t = makeTracker()
    await assert.rejects(
      () => t.getSyncStatus(),
      /Error getting sync status: empty result/
    )
  })

  it('throws when result is missing entirely', async () => {
    stubAxiosPost({ data: {} })
    const t = makeTracker()
    await assert.rejects(
      () => t.getSyncStatus(),
      /Error getting sync status: empty result/
    )
  })

  it('propagates transport errors', async () => {
    stubAxiosPostThrow(new Error('ECONNREFUSED'))
    const t = makeTracker()
    await assert.rejects(
      () => t.getSyncStatus(),
      /ECONNREFUSED/
    )
  })

  it('sets a timeout on the request', async () => {
    let capturedOptions
    axios.post = async (url, data, options) => {
      capturedOptions = options
      return { data: { result: { lag: 0, synced: true } } }
    }
    const t = makeTracker()
    await t.getSyncStatus()
    assert.ok(typeof capturedOptions.timeout === 'number' && capturedOptions.timeout > 0)
  })
})
