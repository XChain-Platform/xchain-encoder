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
const UtxoTracker = require('../../../../src/build/utxo_tracker')
const {
  axios,
  installAxiosHooks,
  makeUtxo
} = require('./helpers/support')

const ADDRESS = 'mhqpGkU1tUYKFrmtFDXEcBiMqzaZTbEPxX'
const HEALTHY = { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: true }

function tracker (profile = 'default', maxLagBlocks = 2) {
  return new UtxoTracker('127.0.0.1', 18420, profile, maxLagBlocks)
}

function stubStatusAndPage (status, page) {
  axios.post = async (url, request) => {
    if (request.method === 'get_sync_status') return { data: { result: status } }
    return { data: { result: page } }
  }
}

describe('UtxoTracker.getUtxosFromAddress() freshness gate', () => {
  installAxiosHooks()

  it('refuses a page above the encoder lag ceiling even when synced is true', async () => {
    const stale = { tracker_height: 97, node_height: 100, lag: 3, synced: true, mempool_ready: true }
    stubStatusAndPage(stale, { utxos: [makeUtxo()], sync: stale })

    await assert.rejects(
      () => tracker().getUtxosFromAddress(ADDRESS),
      err => err.operational === true && err.xchainCode === 'UTXO_TRACKER_STALE' && err.details.lag === 3
    )
  })

  it('refuses a page whose mempool view became unavailable after preflight', async () => {
    const pageSync = { ...HEALTHY, mempool_ready: false }
    stubStatusAndPage(HEALTHY, { utxos: [makeUtxo()], sync: pageSync })

    await assert.rejects(
      () => tracker().getUtxosFromAddress(ADDRESS),
      err => err.operational === true && err.xchainCode === 'UTXO_TRACKER_NOT_READY'
    )
  })

  it('refuses an unhealthy first page before a later page can authorize its rows', async () => {
    let pageRequests = 0
    axios.post = async (url, request) => {
      if (request.method === 'get_sync_status') return { data: { result: HEALTHY } }
      pageRequests++
      if (pageRequests === 1) {
        return { data: { result: { utxos: [makeUtxo()], nextCursor: 'page-2', sync: { ...HEALTHY, mempool_ready: false } } } }
      }
      return { data: { result: { utxos: [], sync: HEALTHY } } }
    }

    await assert.rejects(
      () => tracker().getUtxosFromAddress(ADDRESS),
      err => err.operational === true && err.xchainCode === 'UTXO_TRACKER_NOT_READY'
    )
    assert.strictEqual(pageRequests, 1)
  })

  it('refuses a page whose tracker halted after preflight', async () => {
    const pageSync = { ...HEALTHY, halted: true, halt_reason: 'reorg recovery stopped' }
    stubStatusAndPage(HEALTHY, { utxos: [makeUtxo()], sync: pageSync })

    await assert.rejects(
      () => tracker().getUtxosFromAddress(ADDRESS),
      err => err.operational === true && err.xchainCode === 'UTXO_TRACKER_HALTED'
    )
  })

  it('keeps the default profile fail-open behavior for a page without sync', async () => {
    stubStatusAndPage(HEALTHY, { utxos: [makeUtxo()] })

    const result = await tracker().getUtxosFromAddress(ADDRESS)
    assert.strictEqual(result.utxos.length, 1)
    assert.strictEqual(result.sync, undefined)
  })

  it('refuses a page without sync on the remote profile', async () => {
    stubStatusAndPage(HEALTHY, { utxos: [makeUtxo()] })

    await assert.rejects(
      () => tracker('remote').getUtxosFromAddress(ADDRESS),
      err => err.operational === true && err.xchainCode === 'UTXO_TRACKER_SYNC_MISSING'
    )
  })

  it('returns a healthy classified page unchanged', async () => {
    const page = { utxos: [makeUtxo()], sync: { ...HEALTHY, lag: 2, tracker_height: 98 } }
    stubStatusAndPage(HEALTHY, page)

    const result = await tracker().getUtxosFromAddress(ADDRESS)
    assert.strictEqual(result.utxos.length, 1)
    assert.deepStrictEqual(result.sync, page.sync)
  })
})
