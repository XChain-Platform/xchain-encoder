// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Regression coverage for the M-11 encoder half (2026-07-08): the encoder
// consumes the utxo-tracker's per-response freshness surface (a `sync`
// sibling field on get_utxos: {tracker_height, node_height, lag, synced},
// added to the tracker in ce16bdd) and refuses to select from a stale view
// instead of risking an already-spent or missing UTXO.

// L-2-style test below requires src/api.js, which constructs an encoder from
// env at load time; set the minimum viable env BEFORE the require so
// construction succeeds without a live node. dotenv does not override
// already-set vars.
process.env.NETWORK = process.env.NETWORK || 'bitcoin-regtest'
process.env.NODE_URL = process.env.NODE_URL || '127.0.0.1'
process.env.NODE_PORT = process.env.NODE_PORT || '8332'
process.env.NODE_USER = process.env.NODE_USER || 'test'
process.env.NODE_PASSWORD = process.env.NODE_PASSWORD || 'test'

const assert = require('assert')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const XChainEncoder = require('../../src/XChainEncoder')

describe('M-11 (encoder half): utxo-tracker freshness gate', () => {

  describe('stale gate fires', () => {
    it('throws UTXO_TRACKER_STALE when the tracker reports synced=false', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        sync: { tracker_height: 90, node_height: 100, lag: 10, synced: false }
      })

      await assert.rejects(
        () => encoder.createTransaction(
          null, address, null, 'test', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'UTXO_TRACKER_STALE' &&
                 err.details.lag === 10 &&
                 err.details.tracker_height === 90 &&
                 err.details.node_height === 100
      )
    })

    it('throws UTXO_TRACKER_STALE when lag exceeds the configured threshold, even if synced=true', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      // synced=true here to isolate the lag-threshold branch from the
      // tracker's own synced verdict: our default threshold (2) is tighter
      // than a hypothetical tracker-side verdict that considers lag=5 fine.
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        sync: { tracker_height: 95, node_height: 100, lag: 5, synced: true }
      })

      await assert.rejects(
        () => encoder.createTransaction(
          null, address, null, 'test', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'UTXO_TRACKER_STALE' &&
                 err.details.lag === 5
      )
    })

    it('respects a custom UTXO_TRACKER_MAX_LAG_BLOCKS threshold passed to the constructor', async () => {
      // lag=3 would fail the default threshold (2) but passes a wider one (5).
      const encoder = new XChainEncoder(
        'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '', null, undefined, 5
      )
      const address = getTestAddress('bitcoin-regtest')
      encoder.connector = { getFeePerKilobyte: async () => 0.00001, getTransactionHex: async () => null, isRegtest: async () => true }
      encoder.utxoTrackerConnector = {
        getUtxosFromAddress: async () => ({
          utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
          sync: { tracker_height: 97, node_height: 100, lag: 3, synced: true }
        })
      }

      const result = await encoder.createTransaction(
        null, address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt, 'a lag under the custom threshold must build normally')
    })
  })

  describe('lag below threshold passes', () => {
    it('builds normally when lag is under the default 2-block threshold', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        sync: { tracker_height: 99, node_height: 100, lag: 1, synced: true }
      })

      const result = await encoder.createTransaction(
        null, address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt, 'lag within threshold and synced=true must not gate')
    })

    it('builds normally at exactly the threshold (lag == 2 is not "above")', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        sync: { tracker_height: 98, node_height: 100, lag: 2, synced: true }
      })

      const result = await encoder.createTransaction(
        null, address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt, 'lag exactly at the threshold must not gate')
    })
  })

  describe('absent freshness surface passes (backward compat)', () => {
    it('builds normally when the tracker response has no sync field (pre-ce16bdd tracker)', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)]
        // no `sync` key at all
      })

      const result = await encoder.createTransaction(
        null, address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt, 'an older tracker with no freshness surface must fail open')
    })

    it('builds normally when sync is present but lag is null (unknown, not "above")', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)],
        sync: { tracker_height: -1, node_height: -1, lag: null, synced: true }
      })

      const result = await encoder.createTransaction(
        null, address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt, 'an unknown (null) lag must not be treated as exceeding the threshold')
    })
  })

  describe('caller-supplied UTXOs bypass the gate', () => {
    it('never consults or gates on the tracker when UTXOs are explicitly provided', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      let trackerCalled = false
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        // Even a maximally stale response must never be consulted here.
        return { utxos: [utxo], sync: { tracker_height: 0, node_height: 1000, lag: 1000, synced: false } }
      }

      const result = await encoder.createTransaction(
        [utxo], address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt)
      assert.strictEqual(trackerCalled, false, 'explicit coin-control must skip the tracker entirely')
    })
  })

  describe('api.js maps UTXO_TRACKER_STALE to -32010', () => {
    const { OperationalError } = require('../../src/errors')
    const { jsonRpcController, encoder } = require('../../src/api')
    const address = getTestAddress('bitcoin-regtest')

    it('forwards the stale-tracker error with a machine-readable reason and lag details', async () => {
      encoder.createTransaction = async () => {
        throw new OperationalError('UTXO_TRACKER_STALE',
          'utxo-tracker view is stale (lag 10 blocks, exceeds 2-block threshold); refusing to select utxos from it',
          { lag: 10, tracker_height: 90, node_height: 100 })
      }

      let caught
      try {
        await jsonRpcController.create_tx({ pubkey: address, data: 'test' })
      } catch (e) {
        caught = e
      }
      assert.ok(caught, 'create_tx should reject')
      assert.strictEqual(caught.code, -32010)
      assert.strictEqual(caught.data.reason, 'UTXO_TRACKER_STALE')
      assert.strictEqual(caught.data.lag, 10)
      assert.strictEqual(caught.data.tracker_height, 90)
      assert.strictEqual(caught.data.node_height, 100)
      assert.ok(/stale/.test(caught.message))
    })
  })
})
