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
  makeUtxo,
  stubAxiosPostThrow,
  stubSyncedThenUtxos
} = require('./helpers/support')

const ADDRESS = 'mhqpGkU1tUYKFrmtFDXEcBiMqzaZTbEPxX'

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('calls getSyncStatus before fetching UTXOs', async () => {
    let syncCalled = false
    let utxosCalled = false
    let callCount = 0
    axios.post = async (url, data) => {
      callCount++
      if (callCount === 1) {
        syncCalled = true
        return { data: { result: { lag: 0, synced: true } } }
      }
      utxosCalled = true
      return { data: { result: { utxos: [makeUtxo()] } } }
    }
    const t = makeTracker()
    await t.getUtxosFromAddress(ADDRESS)
    assert.strictEqual(syncCalled, true, 'getSyncStatus should be called first')
    assert.strictEqual(utxosCalled, true, 'get_utxos should be called second')
  })

  it('sends get_utxos with the address param', async () => {
    let capturedPayload
    let callCount = 0
    axios.post = async (url, data) => {
      callCount++
      if (callCount === 1) return { data: { result: { lag: 0, synced: true } } }
      capturedPayload = data
      return { data: { result: { utxos: [makeUtxo()] } } }
    }
    const t = makeTracker()
    await t.getUtxosFromAddress(ADDRESS)
    assert.strictEqual(capturedPayload.method, 'get_utxos')
    assert.strictEqual(capturedPayload.params.address, ADDRESS)
    assert.strictEqual(typeof capturedPayload.params.limit, 'number', 'params must include a numeric limit for pagination')
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('returns the result object on success', async () => {
    const utxo = makeUtxo()
    stubSyncedThenUtxos([utxo])
    const t = makeTracker()
    const result = await t.getUtxosFromAddress(ADDRESS)
    assert.ok(Array.isArray(result.utxos))
    assert.strictEqual(result.utxos.length, 1)
    assert.strictEqual(result.utxos[0].txid, utxo.txid)
  })

  it('defaults confirmations to 0 when null', async () => {
    const utxo = makeUtxo({ confirmations: null })
    stubSyncedThenUtxos([utxo])
    const t = makeTracker()
    const result = await t.getUtxosFromAddress(ADDRESS)
    assert.strictEqual(result.utxos[0].confirmations, 0)
  })

  it('defaults confirmations to 0 when undefined', async () => {
    const utxo = makeUtxo()
    delete utxo.confirmations
    stubSyncedThenUtxos([utxo])
    const t = makeTracker()
    const result = await t.getUtxosFromAddress(ADDRESS)
    assert.strictEqual(result.utxos[0].confirmations, 0)
  })

  it('preserves existing confirmations when > 0', async () => {
    const utxo = makeUtxo({ confirmations: 10 })
    stubSyncedThenUtxos([utxo])
    const t = makeTracker()
    const result = await t.getUtxosFromAddress(ADDRESS)
    assert.strictEqual(result.utxos[0].confirmations, 10)
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('coerces numeric-string confirmations and rejects non-integer values', async () => {
    stubSyncedThenUtxos([makeUtxo({ confirmations: '7' })])
    let t = makeTracker()
    let result = await t.getUtxosFromAddress(ADDRESS)
    assert.strictEqual(result.utxos[0].confirmations, 7)

    for (const bad of [1.5, -1, 'abc', {}]) {
      stubSyncedThenUtxos([makeUtxo({ confirmations: bad })])
      t = makeTracker()
      await assert.rejects(
        () => t.getUtxosFromAddress(ADDRESS),
        /confirmations must be a non-negative integer/
      )
    }
  })

  it('throws when tracker is not synced (synced=false)', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        return { data: { result: { lag: 10, synced: false } } }
      }
      return { data: { result: { utxos: [] } } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /lagging by 10 blocks/
    )
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  // halted is published independently of synced, so a tracker frozen on
  // an unrecoverable reorg whose frozen height still shows an acceptable lag passed
  // this preflight and its rolled-back UTXOs reached input selection.
  it('throws when the tracker is halted, even at lag 0 with synced=true', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        return { data: { result: { lag: 0, synced: true, halted: true, halt_reason: 'rolled back past the recovery window' } } }
      }
      return { data: { result: { utxos: [] } } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /halted \(rolled back past the recovery window\)/
    )
  })

  // A negative lag means the node reset or reindexed below our committed
  // tip, so the outputs we would select live in blocks it no longer recognizes. The
  // encoder checks it itself because it fails open on trackers lacking the fix.
  it('throws when the tracker is ahead of the node (negative lag)', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        return { data: { result: { lag: -100, synced: true } } }
      }
      return { data: { result: { utxos: [] } } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /100 blocks ahead of the node/
    )
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  // Block sync flips true before the first mempool rebuild finishes, so at
  // lag 0 with synced:true the tracker can still hand back a confirmed output already
  // spent in the node's mempool, which its empty index cannot filter.
  it('throws when the tracker has not reconverged its mempool, even at lag 0', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        return { data: { result: { lag: 0, synced: true, mempool_ready: false } } }
      }
      return { data: { result: { utxos: [] } } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /has not reconverged its mempool/
    )
  })

  // Refusal-cause attribution. get_sync_status derives mempool_ready as
  // `synced && isMempoolReconverged()`, so a tracker that is merely lagging publishes
  // mempool_ready:false as well and BOTH gates are eligible. The operator must be told
  // the block lag, which is actionable and self-clearing, not sent hunting a mempool
  // rebuild that is not the fault. Pins the ordering, so moving the readiness gate back
  // above the sync gate reddens here.
  it('names the block lag, not mempool reconvergence, when a lagging tracker de-asserts both', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        return { data: { result: { lag: 50, synced: false, mempool_ready: false } } }
      }
      return { data: { result: { utxos: [] } } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /lagging by 50 blocks/
    )
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  // Fail-open parity with create_tx: a tracker predating the field omits it entirely
  // and must still be fetchable, or every un-upgraded tracker in the fleet goes dark.
  it('fetches normally from a tracker that omits mempool_ready', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        return { data: { result: { lag: 0, synced: true } } }
      }
      return { data: { result: { utxos: [] } } }
    }
    const t = makeTracker()
    assert.deepStrictEqual(await t.getUtxosFromAddress(ADDRESS), { utxos: [] })
  })

  it('throws when lag is null (tracker has not indexed any blocks)', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        return { data: { result: { lag: null, synced: false } } }
      }
      return { data: { result: { utxos: [] } } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /has not indexed any blocks/
    )
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('throws when lag is undefined', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        return { data: { result: { synced: false } } }
      }
      return { data: { result: { utxos: [] } } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /has not indexed any blocks/
    )
  })

  it('throws when getSyncStatus transport fails', async () => {
    stubAxiosPostThrow(new Error('tracker offline'))
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /tracker offline/
    )
  })
})
