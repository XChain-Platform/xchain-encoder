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
const BlockchainConnector = require('../../../src/build/blockchain_connector')
const XChainEncoder = require('../../../src/XChainEncoder')

function makeConnector () {
  return new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
}

describe('BlockchainConnector.getBlockCount()', () => {
  let originalPost
  beforeEach(() => { originalPost = axios.post })
  afterEach(() => { axios.post = originalPost })

  it('sends getblockcount', async () => {
    let captured
    axios.post = async (url, data) => { captured = data; return { data: { result: 1 } } }
    await makeConnector().getBlockCount()
    assert.strictEqual(captured.method, 'getblockcount')
  })

  it('returns a real integer tip, including a genesis tip of 0', async () => {
    axios.post = async () => ({ data: { result: 960900 } })
    assert.strictEqual(await makeConnector().getBlockCount(), 960900)
    axios.post = async () => ({ data: { result: 0 } })
    assert.strictEqual(await makeConnector().getBlockCount(), 0)
  })

  // Each of these used to coerce through Number() into a finite tip.
  const unreadable = [
    ['result null', { data: { result: null } }],
    ['result empty string', { data: { result: '' } }],
    ['result false', { data: { result: false } }],
    ['result true', { data: { result: true } }],
    ['result numeric string', { data: { result: '960900' } }],
    ['result fraction', { data: { result: 1.5 } }],
    ['result negative', { data: { result: -1 } }],
    ['no result key', { data: {} }],
    ['empty body', { data: '' }],
    ['undefined body', { data: undefined }],
    ['undefined response', undefined],
    ['error body with null result', { data: { result: null, error: { code: -28, message: 'Loading block index...' } } }],
    ['error body beside a result', { data: { result: 960900, error: { code: -1, message: 'x' } } }],
  ]
  for (const [label, response] of unreadable) {
    it(`returns null for ${label}`, async () => {
      axios.post = async () => response
      assert.strictEqual(await makeConnector().getBlockCount(), null)
    })
  }

  it('returns null when the request throws', async () => {
    axios.post = async () => { throw new Error('socket hang up') }
    assert.strictEqual(await makeConnector().getBlockCount(), null)
  })

  it('makes the envelope gate report an unknown tip, not a countdown, for result null', async () => {
    axios.post = async () => ({ data: { result: null } })
    const ctx = { networkKey: 'bitcoin-mainnet', connector: makeConnector() }
    await assert.rejects(
      () => XChainEncoder.prototype.assertEnvelopeRecognized.call(ctx),
      (e) => e.xchainCode === 'ENVELOPE_RECOGNITION_UNKNOWN'
    )
  })
})
