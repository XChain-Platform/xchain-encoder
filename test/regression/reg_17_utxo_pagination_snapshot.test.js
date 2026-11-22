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
const UtxoTracker = require('../../src/build/utxo_tracker')

const SCRIPT = '0014' + '11'.repeat(20)
const HEALTHY_STATUS = { synced: true, lag: 0, halted: false, mempool_ready: true }

function utxo (txidChar) {
  return { txid: txidChar.repeat(64), vout: 0, value: 1000, scriptPubKey: SCRIPT, confirmations: 6 }
}

// First call is the get_sync_status pre-flight; the rest are get_utxos pages. The
// pages repeat in order, so a fetch that restarts from page 1 reads the same
// divergent sequence again: a tracker whose snapshot keeps moving on every attempt.
function stubPages (pages) {
  let call = 0
  axios.post = async () => {
    call++
    if (call === 1) return { data: { result: HEALTHY_STATUS } }
    return { data: { result: pages[(call - 2) % pages.length] } }
  }
  return () => call - 1
}

// A tracker that pages like the real one: it caps each page at maxPage rows
// whatever limit the caller asks for, and sends a cursor whenever a page is full.
// syncAt(n) gives the sync sibling of the n-th get_utxos request (0-based).
function stubTracker ({ count, maxPage, syncAt }) {
  const rows = []
  for (let i = 0; i < count; i++) {
    rows.push({ txid: i.toString(16).padStart(64, '0'), vout: 0, value: 1000, scriptPubKey: SCRIPT, confirmations: 6 })
  }
  const requests = []
  axios.post = async (url, body) => {
    if (body.method === 'get_sync_status') return { data: { result: HEALTHY_STATUS } }
    const n = requests.length
    requests.push(body.params)
    const start = body.params.after ? Number(body.params.after) : 0
    const limit = Math.min(body.params.limit, maxPage)
    const page = rows.slice(start, start + limit).map((r) => ({ ...r }))
    const result = { utxos: page, sync: syncAt(n) }
    if (page.length === limit) result.nextCursor = String(start + limit)
    return { data: { result } }
  }
  return requests
}

function syncAtHeight (height) {
  return { tracker_height: height, node_height: height, lag: 0, synced: true, reorg_count: 0, committed_hash: String(height).padStart(64, '0') }
}

describe('an address holding exactly the cap survives a block between its two page reads @regression', function () {
  const origPost = axios.post
  afterEach(() => { axios.post = origPost })

  it('returns all cap UTXOs when one block lands between page 1 and the cursor page', async function () {
    // At the default cap of 10000 the tracker's full first page carries a cursor, so
    // the fetch always reads a second page. One block mined between those two reads
    // must cost a fresh read, not a refusal.
    const requests = stubTracker({ count: 10000, maxPage: 10000, syncAt: (n) => syncAtHeight(n === 0 ? 100 : 101) })
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    const out = await tracker.getUtxosFromAddress('someaddr')
    assert.strictEqual(out.utxos.length, 10000)
    assert.strictEqual(new Set(out.utxos.map((u) => u.txid)).size, 10000)
    assert.strictEqual(out.sync.tracker_height, 101)
    // Two reads at height 100 then 101 (refused merge), then two reads at 101.
    assert.strictEqual(requests.length, 4)
  })

  it('still refuses when the snapshot moves on every read', async function () {
    const requests = stubTracker({ count: 3, maxPage: 3, syncAt: (n) => syncAtHeight(100 + n) })
    const tracker = new UtxoTracker('127.0.0.1', '1234', undefined, undefined, 3)
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), /chain state changed while paginating/)
    // The first attempt plus a bounded number of restarts, two reads each.
    assert.strictEqual(requests.length, 6)
  })

  it('still refuses an address holding one more than the cap', async function () {
    stubTracker({ count: 4, maxPage: 3, syncAt: () => syncAtHeight(100) })
    const tracker = new UtxoTracker('127.0.0.1', '1234', undefined, undefined, 3)
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), (e) => e.code === 'UTXO_SET_TOO_LARGE')
  })

  it('refuses a tracker that halts mid-fetch without restarting', async function () {
    const requests = stubTracker({
      count: 3,
      maxPage: 3,
      syncAt: (n) => (n === 0 ? syncAtHeight(100) : { ...syncAtHeight(100), halted: true, halt_reason: 'unrecoverable reorg' })
    })
    const tracker = new UtxoTracker('127.0.0.1', '1234', undefined, undefined, 3)
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), /halted mid-fetch/)
    assert.strictEqual(requests.length, 2)
  })
})

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
})

describe('paginated utxo fetch is one chain-state snapshot @regression', function () {
  const origPost = axios.post
  afterEach(() => { axios.post = origPost })

  it('refuses when a later page reports the tracker halted', async function () {
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true } },
      { utxos: [utxo('b')], sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, halted: true, halt_reason: 'unrecoverable reorg' } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), /halted mid-fetch/)
  })
})

describe('paginated utxo fetch is one chain-state snapshot @regression', function () {
  const origPost = axios.post
  afterEach(() => { axios.post = origPost })

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
})

describe('paginated utxo fetch is one chain-state snapshot @regression', function () {
  const origPost = axios.post
  afterEach(() => { axios.post = origPost })

  it('refuses when the tip hash changes while height and reorg count hold', async function () {
    // A counter reset by a restart, or a rollback it never recorded, leaves reorg_count
    // equal across a same-height swap; the committed tip hash still names the chain.
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, lag: 0, synced: true, reorg_count: 0, committed_hash: 'aa'.repeat(32) } },
      { utxos: [utxo('b')], sync: { tracker_height: 100, lag: 0, synced: true, reorg_count: 0, committed_hash: 'bb'.repeat(32) } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), /switched to a different chain tip mid-fetch/)
  })

  it('merges pages read on one chain tip', async function () {
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, lag: 0, synced: true, reorg_count: 0, committed_hash: 'aa'.repeat(32) } },
      { utxos: [utxo('b')], sync: { tracker_height: 100, lag: 0, synced: true, reorg_count: 0, committed_hash: 'aa'.repeat(32) } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    const out = await tracker.getUtxosFromAddress('someaddr')
    assert.strictEqual(out.utxos.length, 2)
  })

  it('refuses when the mempool changes at an unchanged chain tip', async function () {
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, lag: 0, synced: true, mempool_epoch: 10 } },
      { utxos: [utxo('b')], sync: { tracker_height: 100, lag: 0, synced: true, mempool_epoch: 11 } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), /mempool changed mid-fetch/)
  })

  it('keeps compatibility when a later page omits the mempool epoch', async function () {
    stubPages([
      { utxos: [utxo('a')], nextCursor: 'PAGE2', sync: { tracker_height: 100, lag: 0, synced: true, mempool_epoch: 10 } },
      { utxos: [utxo('b')], sync: { tracker_height: 100, lag: 0, synced: true } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    const out = await tracker.getUtxosFromAddress('someaddr')
    assert.strictEqual(out.utxos.length, 2)
  })
})

describe('paginated utxo fetch is one chain-state snapshot @regression', function () {
  const origPost = axios.post
  afterEach(() => { axios.post = origPost })

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
})

describe('paginated utxo fetch is one chain-state snapshot @regression', function () {
  const origPost = axios.post
  afterEach(() => { axios.post = origPost })

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
})

describe('paginated utxo fetch is one chain-state snapshot @regression', function () {
  const origPost = axios.post
  afterEach(() => { axios.post = origPost })

  it('leaves the single-page path untouched', async function () {
    stubPages([
      { utxos: [utxo('a')], sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true } }
    ])
    const tracker = new UtxoTracker('127.0.0.1', '1234')
    const out = await tracker.getUtxosFromAddress('someaddr')
    assert.strictEqual(out.utxos.length, 1)
  })
})
