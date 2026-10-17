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

describe('BlockchainConnector.getFeePerKilobyte() test-chain implausible estimate', () => {
  let originalPost
  let originalNetwork

  beforeEach(() => {
    originalPost = axios.post
    originalNetwork = process.env.NETWORK
    process.env.NETWORK = 'bitcoin-testnet'
  })

  afterEach(() => {
    axios.post = originalPost
    if (originalNetwork === undefined) delete process.env.NETWORK
    else process.env.NETWORK = originalNetwork
  })

  it('uses the no-estimate fallback instead of clamping an estimate above the sanity ceiling', async () => {
    axios.post = async (url, data) => {
      if (data.method === 'getblockchaininfo') return { data: { result: { chain: 'testnet4' } } }
      if (data.method === 'estimatesmartfee') return { data: { result: { feerate: 7.48876052, blocks: 6 } } }
      if (data.method === 'getnetworkinfo') return { data: { result: { relayfee: 0.000001 } } }
      return { data: { result: {} } }
    }

    const connector = new BlockchainConnector('127.0.0.1', 18332, 'rpcuser', 'rpcpass')
    const feerate = await connector.getFeePerKilobyte(6)

    assert.ok(Math.abs(feerate - 0.00001) < 1e-12,
      'expected 10x the 0.000001 relay floor, got ' + feerate)
  })
})
