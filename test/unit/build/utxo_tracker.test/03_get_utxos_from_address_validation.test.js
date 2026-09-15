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
  stubSyncedThenUtxos
} = require('./helpers/support')

const ADDRESS = 'mhqpGkU1tUYKFrmtFDXEcBiMqzaZTbEPxX'

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('throws when UTXO result is missing', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) return { data: { result: { lag: 0, synced: true } } }
      return { data: { result: null } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /Error getting utxos: empty result/
    )
  })

  it('throws when UTXO result is not an object', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) return { data: { result: { lag: 0, synced: true } } }
      return { data: { result: 'bad' } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /Error getting utxos: empty result/
    )
  })

  it('throws TypeError when utxos is not an array', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) return { data: { result: { lag: 0, synced: true } } }
      return { data: { result: { utxos: 'not-an-array' } } }
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /UTXO tracker result missing utxos array/ }
    )
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('throws TypeError for malformed UTXO (missing txid)', async () => {
    const badUtxo = makeUtxo()
    delete badUtxo.txid
    stubSyncedThenUtxos([badUtxo])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /malformed utxo at index 0/ }
    )
  })

  it('throws TypeError for malformed UTXO (txid not a string)', async () => {
    const badUtxo = makeUtxo({ txid: 12345 })
    stubSyncedThenUtxos([badUtxo])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /malformed utxo at index 0/ }
    )
  })

  it('throws TypeError when txid is not a 64-char hex string (too short)', async () => {
    const badUtxo = makeUtxo({ txid: 'abc123' })
    stubSyncedThenUtxos([badUtxo])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /64-character hex string/ }
    )
  })

  it('throws TypeError when txid is 64 chars but not hex', async () => {
    const badUtxo = makeUtxo({ txid: 'z'.repeat(64) })
    stubSyncedThenUtxos([badUtxo])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /64-character hex string/ }
    )
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('throws TypeError for malformed UTXO (missing vout)', async () => {
    const badUtxo = makeUtxo()
    delete badUtxo.vout
    stubSyncedThenUtxos([badUtxo])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /malformed utxo at index 0/ }
    )
  })

  it('throws TypeError for malformed UTXO (missing value)', async () => {
    const badUtxo = makeUtxo()
    delete badUtxo.value
    stubSyncedThenUtxos([badUtxo])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /malformed utxo at index 0/ }
    )
  })

  it('throws TypeError when scriptPubKey is missing', async () => {
    const badUtxo = makeUtxo()
    delete badUtxo.scriptPubKey
    stubSyncedThenUtxos([badUtxo])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /scriptPubKey must be a non-empty string/ }
    )
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('throws TypeError when scriptPubKey is an empty string', async () => {
    const badUtxo = makeUtxo({ scriptPubKey: '' })
    stubSyncedThenUtxos([badUtxo])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /scriptPubKey must be a non-empty string/ }
    )
  })

  it('throws TypeError when a UTXO element is null', async () => {
    stubSyncedThenUtxos([null])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      { name: 'TypeError', message: /malformed utxo at index 0/ }
    )
  })

  it('accepts an empty utxos array', async () => {
    stubSyncedThenUtxos([])
    const t = makeTracker()
    const result = await t.getUtxosFromAddress(ADDRESS)
    assert.deepStrictEqual(result.utxos, [])
  })
})

describe('UtxoTracker.getUtxosFromAddress()', () => {
  installAxiosHooks()

  it('handles multiple valid UTXOs correctly', async () => {
    const utxo1 = makeUtxo({ txid: 'a'.repeat(64), vout: 0, value: 10000 })
    const utxo2 = makeUtxo({ txid: 'b'.repeat(64), vout: 1, value: 20000 })
    stubSyncedThenUtxos([utxo1, utxo2])
    const t = makeTracker()
    const result = await t.getUtxosFromAddress(ADDRESS)
    assert.strictEqual(result.utxos.length, 2)
    assert.strictEqual(result.utxos[1].txid, 'b'.repeat(64))
  })

  it('reports the correct index in malformed UTXO error for second item', async () => {
    const good = makeUtxo({ txid: 'a'.repeat(64) })
    const bad = makeUtxo({ txid: 'short' })
    stubSyncedThenUtxos([good, bad])
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /index 1/
    )
  })

  it('rethrows get_utxos transport errors', async () => {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) return { data: { result: { lag: 0, synced: true } } }
      throw new Error('Connection reset by peer')
    }
    const t = makeTracker()
    await assert.rejects(
      () => t.getUtxosFromAddress(ADDRESS),
      /Connection reset by peer/
    )
  })
})
