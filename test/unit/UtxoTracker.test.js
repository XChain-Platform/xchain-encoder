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
const axios = require('axios')
const UtxoTracker = require('../../src/UtxoTracker')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTracker () {
  return new UtxoTracker('127.0.0.1', 18420)
}

let originalPost

beforeEach(() => {
  originalPost = axios.post
})

afterEach(() => {
  axios.post = originalPost
})

function stubAxiosPost (response) {
  axios.post = async () => response
}

function stubAxiosPostThrow (err) {
  axios.post = async () => { throw err }
}

// A minimal valid UTXO fixture
function makeUtxo (overrides) {
  return Object.assign({
    txid: 'a'.repeat(64),
    vout: 0,
    value: 50000000,
    scriptPubKey: '76a914' + 'ab'.repeat(20) + '88ac',
    confirmations: 6
  }, overrides)
}

// A stub that returns synced status first, then UTXOs
function stubSyncedThenUtxos (utxos) {
  let callCount = 0
  axios.post = async (url, data) => {
    callCount++
    if (callCount === 1) {
      // getSyncStatus call
      return {
        data: {
          result: {
            committed_height: 100,
            tracker_height: 100,
            node_height: 100,
            lag: 0,
            synced: true
          }
        }
      }
    }
    // get_utxos call
    return { data: { result: { utxos } } }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────────────────────

describe('UtxoTracker constructor', () => {
  it('builds the correct URL from host and port', () => {
    const t = new UtxoTracker('myhost', 12345)
    assert.strictEqual(t.url, 'http://myhost:12345')
  })

  it('stores the port', () => {
    const t = new UtxoTracker('h', 9999)
    assert.strictEqual(t.port, 9999)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getSyncStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('UtxoTracker.getSyncStatus()', () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// getUtxosFromAddress
// ─────────────────────────────────────────────────────────────────────────────

describe('UtxoTracker.getUtxosFromAddress()', () => {
  const ADDRESS = 'mhqpGkU1tUYKFrmtFDXEcBiMqzaZTbEPxX'

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
    assert.deepStrictEqual(capturedPayload.params, { address: ADDRESS })
  })

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
