// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const XChainEncoder = require('../../src/XChainEncoder')

function makeEncoder () {
  return new XChainEncoder(
    'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
}

describe('XChainEncoder.isSegwitUTXO()', () => {
  let encoder

  beforeEach(() => {
    encoder = makeEncoder()
  })

  it('returns true for P2WPKH (version 0, 20-byte hash)', () => {
    // OP_0 PUSH_20 <20-byte-hash>
    const script = '0014' + 'ab'.repeat(20)
    assert.strictEqual(encoder.isSegwitUTXO({ scriptPubKey: script }), true)
  })

  it('returns true for P2WSH (version 0, 32-byte hash)', () => {
    // OP_0 PUSH_32 <32-byte-hash>
    const script = '0020' + 'cd'.repeat(32)
    assert.strictEqual(encoder.isSegwitUTXO({ scriptPubKey: script }), true)
  })

  it('returns false for P2PKH', () => {
    // OP_DUP OP_HASH160 PUSH_20 <hash> OP_EQUALVERIFY OP_CHECKSIG
    const script = '76a914' + 'ab'.repeat(20) + '88ac'
    assert.strictEqual(encoder.isSegwitUTXO({ scriptPubKey: script }), false)
  })

  it('returns false for P2SH', () => {
    // OP_HASH160 PUSH_20 <hash> OP_EQUAL
    const script = 'a914' + 'ab'.repeat(20) + '87'
    assert.strictEqual(encoder.isSegwitUTXO({ scriptPubKey: script }), false)
  })

  it('returns false for invalid hex string', () => {
    assert.strictEqual(encoder.isSegwitUTXO({ scriptPubKey: 'not-hex' }), false)
  })

  it('returns false for empty string', () => {
    assert.strictEqual(encoder.isSegwitUTXO({ scriptPubKey: '' }), false)
  })

  it('returns false when scriptPubKey is missing', () => {
    assert.strictEqual(encoder.isSegwitUTXO({}), false)
  })
})
