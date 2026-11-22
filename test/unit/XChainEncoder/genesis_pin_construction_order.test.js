// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// CryptoNetworks.getChainGenesisHash answers null (unpinned) for a key it cannot parse,
// and the connector reads null as "skip the block-0 check". The only thing keeping an
// unknown network from disarming that check is the constructor resolving the bitcoinjs
// network first, which throws. These tests pin that order and the hand-off of the pin.

const assert = require('assert')
const CryptoNetworks = require('../../../src/build/crypto_networks')
const XChainEncoder = require('../../../src/XChainEncoder')

const PIN = '00'.repeat(32)

describe('XChainEncoder construction order around the block-0 pin', () => {
  let original
  let asked
  beforeEach(() => {
    original = CryptoNetworks.getChainGenesisHash
    asked = []
    CryptoNetworks.getChainGenesisHash = (key) => { asked.push(key); return PIN }
  })
  afterEach(() => { CryptoNetworks.getChainGenesisHash = original })

  it('refuses an unknown network before the pin is looked up', () => {
    assert.throws(
      () => new XChainEncoder('nocoin-mainnet', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''),
      (err) => err instanceof TypeError && err.invalidParams === true && /Unknown network/.test(err.message)
    )
    assert.deepStrictEqual(asked, [], 'the pin lookup must not run for a network that failed to parse')
  })

  it('hands the registry pin for the network key to the node connector', () => {
    const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
    assert.deepStrictEqual(asked, ['bitcoin-regtest'])
    assert.strictEqual(encoder.connector.chainGenesisHash, PIN)
  })
})
