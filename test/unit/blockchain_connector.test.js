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
const BlockchainConnector = require('../../src/build/blockchain_connector')

describe('BlockchainConnector constructor', () => {
  it('builds the correct URL from host and port', () => {
    const c = new BlockchainConnector('myhost', 9999, 'u', 'p')
    assert.strictEqual(c.url, 'http://myhost:9999')
  })

  it('stores rpcUser and rpcPassword', () => {
    const c = new BlockchainConnector('h', 1234, 'alice', 'secret')
    assert.strictEqual(c.rpcUser, 'alice')
    assert.strictEqual(c.rpcPassword, 'secret')
  })
})
