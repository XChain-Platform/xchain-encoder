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
const UtxoTracker = require('../../../src/build/utxo_tracker')

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
