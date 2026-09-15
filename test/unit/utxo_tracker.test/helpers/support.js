// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const axios = require('axios')
const UtxoTracker = require('../../../../src/build/utxo_tracker')

function makeTracker () {
  return new UtxoTracker('127.0.0.1', 18420)
}

function installAxiosHooks () {
  let originalPost
  beforeEach(() => {
    originalPost = axios.post
  })
  afterEach(() => {
    axios.post = originalPost
  })
}

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

module.exports = {
  axios,
  installAxiosHooks,
  makeTracker,
  makeUtxo,
  stubAxiosPost,
  stubAxiosPostThrow,
  stubSyncedThenUtxos
}
