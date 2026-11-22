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
const bitcoin = require('bitcoinjs-lib')
const { axios, installAxiosHooks, makeTracker, makeUtxo } = require('./helpers/support')
const { initInputState, gatherUtxos } = require('../../../../src/XChainEncoder/build_transaction/input_candidates')
const { upstreamErrorMessage } = require('../../../../src/common/error_sanitize')

const ADDRESS = bitcoin.payments.p2pkh({ hash: Buffer.alloc(20, 1), network: bitcoin.networks.regtest }).address
const SYNCED = { committed_height: 100, tracker_height: 100, node_height: 100, lag: 0, synced: true }

// Answer get_sync_status with `sync` and every get_utxos call from `pages` in order.
function stubTracker (sync, pages = []) {
  let page = 0
  axios.post = async (url, data) => {
    if (data.method === 'get_sync_status') return { data: { result: sync } }
    return { data: pages[Math.min(page++, pages.length - 1)] }
  }
}

// Drive input selection the way createTransaction does and return the public error.
async function createTxError () {
  const build = { replacebyfee: false, p2shHash: null, p2shHex: null, options: {}, utxos: null, pubkey: ADDRESS }
  initInputState(build)
  const encoder = { network: bitcoin.networks.regtest, utxoTrackerConnector: makeTracker() }
  const steps = gatherUtxos.call(encoder, build)
  let step = steps.next()
  while (!step.done) {
    let value
    try {
      value = await step.value
    } catch (err) {
      try { steps.throw(err) } catch (thrown) { return thrown }
    }
    step = steps.next(value)
  }
  throw new Error('expected input selection to refuse')
}

async function publicText (sync, pages) {
  stubTracker(sync, pages)
  const err = await createTxError()
  assert.strictEqual(err.xchainCode, 'UTXO_TRACKER_ERROR')
  return err.message
}

describe('UtxoTracker refusals reach create_tx callers as encoder-written text', () => {
  installAxiosHooks()
  let originalError
  beforeEach(() => { originalError = console.error; console.error = () => {} })
  afterEach(() => { console.error = originalError })

  it('keeps the lag and halted refusals the wallet classifies', async () => {
    assert.strictEqual(await publicText({ lag: 97, synced: false }),
      'utxo-tracker is lagging by 97 blocks; refusing to fetch UTXOs')
    assert.strictEqual(await publicText({ lag: 0, synced: true, halted: true, halt_reason: 'rolled back past the recovery window' }),
      'utxo-tracker is halted (rolled back past the recovery window); refusing to fetch UTXOs')
    assert.strictEqual(await publicText({ lag: 0, synced: true, halted: true, halt_reason: 'token=hunter2' }),
      'utxo-tracker is halted (unrecoverable reorg); refusing to fetch UTXOs')
  })

  it('keeps the not-indexed and mempool refusals', async () => {
    assert.strictEqual(await publicText({ lag: null }),
      'utxo-tracker has not indexed any blocks yet; refusing to fetch UTXOs')
    assert.strictEqual(await publicText({ ...SYNCED, mempool_ready: false }),
      'utxo-tracker has not reconverged its mempool yet, so an already-spent confirmed output cannot be filtered; refusing to fetch UTXOs')
  })

  it('never echoes a tracker-supplied lag that is not a block count', async () => {
    const text = await publicText({ lag: 'x rpcpassword=hunter2', synced: false })
    assert.strictEqual(text, 'utxo-tracker is lagging by an unknown number of blocks; refusing to fetch UTXOs')
  })

  it('keeps the malformed-reply and pagination aborts', async () => {
    assert.strictEqual(await publicText(SYNCED, [{ result: { utxos: 'none' } }]), 'UTXO tracker result missing utxos array')
    assert.strictEqual(await publicText(SYNCED, [{ result: { utxos: [makeUtxo({ txid: 'zz' })] } }]),
      'UTXO tracker returned malformed utxo at index 0: txid must be a 64-character hex string')
    const looping = { result: { utxos: [makeUtxo()], nextCursor: 'c1' } }
    assert.strictEqual(await publicText(SYNCED, [looping, looping]),
      `utxo-tracker returned a repeated pagination cursor for ${ADDRESS}; aborting (stalled or hostile tracker)`)
    assert.strictEqual(await publicText(SYNCED, [{}]), 'Error getting utxos: empty result')
  })

  it('keeps the snapshot abort and echoes only short tracker numbers', async () => {
    assert.strictEqual(await publicText({ lag: 1234567890123, synced: false }),
      'utxo-tracker is lagging by an unknown number of blocks; refusing to fetch UTXOs')
    const page = height => ({ result: { utxos: [makeUtxo({ vout: height % 2 })], nextCursor: 'c' + height, sync: { ...SYNCED, tracker_height: height } } })
    const text = await publicText(SYNCED, [page(100), page(1234567890123), page(100), page(1234567890123), page(100), page(1234567890123)])
    assert.strictEqual(text, `utxo-tracker chain state changed while paginating utxos for ${ADDRESS}: ` +
      'the tracker moved from height 100 to an unrecognized value mid-fetch; ' +
      'refusing to merge pages read at different chain states (retry the request)')
  })
})

describe('upstreamErrorMessage caller-safe marker', () => {
  const FALLBACK = 'UTXO tracker unavailable'

  it('does not trust encoder-shaped text on an unmarked error', () => {
    const forged = new Error('utxo-tracker is lagging by 97 blocks; refusing to fetch UTXOs')
    assert.strictEqual(upstreamErrorMessage(forged, FALLBACK), FALLBACK)
  })

  it('still collapses a marked message that names an endpoint', async () => {
    axios.post = async () => ({ data: { result: { utxos: [makeUtxo()], nextCursor: 'c1' } } })
    const tracker = makeTracker()
    tracker.getSyncStatus = async () => SYNCED
    const originalError = console.error
    console.error = () => {}
    try {
      const err = await tracker.getUtxosFromAddress('tracker-db:3306').then(() => null, e => e)
      assert.match(err.message, /repeated pagination cursor for tracker-db:3306/)
      assert.strictEqual(upstreamErrorMessage(err, FALLBACK), FALLBACK)
    } finally {
      console.error = originalError
    }
  })
})
