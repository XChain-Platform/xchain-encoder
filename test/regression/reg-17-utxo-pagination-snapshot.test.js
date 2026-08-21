// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression: a paginated get_utxos fetch merged pages read at different chain
// states. Each page carries its own `sync` sibling, but the merge kept only the
// LAST page's, so a rollback between page N and page N+1 left outputs the rewind
// orphaned in the early pages while the encoder's freshness gate read the final
// page and saw a healthy tracker. The single up-front get_sync_status pre-flight
// cannot see it either: it runs before page 1.
//
// The merged set must now be one snapshot or no set at all.

const assert = require('assert')
const axios = require('axios')
const UtxoTracker = require('../../src/UtxoTracker')

const SCRIPT = '0014' + '11'.repeat(20)
const HEALTHY_STATUS = { synced: true, lag: 0, halted: false, mempool_ready: true }

function utxo (txidChar) {
  return { txid: txidChar.repeat(64), vout: 0, value: 1000, scriptPubKey: SCRIPT, confirmations: 6 }
}

// First call is the get_sync_status pre-flight; the rest are get_utxos pages.
function stubPages (pages) {
  let call = 0
  axios.post = async () => {
    call++
    if (call === 1) return { data: { result: HEALTHY_STATUS } }
    return { data: { result: pages[call - 2] } }
  }
}

describe('paginated utxo fetch is one chain-state snapshot @regression', function () {
  const origPost = axios.post
  afterEach(() => { axios.post = origPost })

  it('refuses to merge pages read at different tracker heights', async function () {
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true } },
      // The rewind-and-re-apply lands on a different height: the merged set would
      // carry page 1's now-orphaned output under page 2's healthy sync meta.
      { utxos: [utxo('b')], sync: { tracker_height: 99, node_height: 100, lag: 1, synced: true } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'),
      /chain state changed while paginating/)
  })

  it('refuses when a later page reports the tracker halted', async function () {
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true } },
      { utxos: [utxo('b')], sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, halted: true, halt_reason: 'unrecoverable reorg' } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), /halted mid-fetch/)
  })

  it('refuses when the reorg counter moves at an unchanged height', async function () {
    // A rewind that re-applies to the SAME height is invisible to a height check.
    // It is caught only when the tracker publishes reorg_count on the page sibling.
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, lag: 0, synced: true, reorg_count: 4 } },
      { utxos: [utxo('b')], sync: { tracker_height: 100, lag: 0, synced: true, reorg_count: 5 } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), /recorded a reorg mid-fetch/)
  })

  it('merges pages that share one snapshot', async function () {
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, reorg_count: 4 } },
      { utxos: [utxo('b')], sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, reorg_count: 4 } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    const out = await tracker.getUtxosFromAddress('someaddr')
    assert.strictEqual(out.utxos.length, 2)
    assert.strictEqual(out.sync.tracker_height, 100)
  })

  it('still merges for a tracker that publishes no per-page sync sibling', async function () {
    // Pre-ce16bdd trackers omit `sync` entirely. There is no snapshot identity to
    // compare, and the up-front get_sync_status pre-flight stays the only freshness
    // evidence, exactly as before this guard existed. Refusing here would take every
    // multi-page address on an older tracker offline for a hazard we cannot observe.
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2' },
      { utxos: [utxo('b')] }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    const out = await tracker.getUtxosFromAddress('someaddr')
    assert.strictEqual(out.utxos.length, 2)
  })

  it('leaves the single-page path untouched', async function () {
    stubPages([
      { utxos: [utxo('a')], sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    const out = await tracker.getUtxosFromAddress('someaddr')
    assert.strictEqual(out.utxos.length, 1)
  })
})
