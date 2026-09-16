/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Smoke Tests: xchain-encoder
 *
 * Fast health-check suite that verifies the encoder's core building blocks
 * are operational. No coin node, no network calls, no external services.
 *
 * Run: npm run smoke-test
 */

const assert = require('assert')
const XChainEncoder = require('../../../src/XChainEncoder');

describe('S9: dataToPubkey', () => {

  let encoder
  before(() => {
    encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', '')
  })

  it('produces 33-byte buffer starting with 0x02', async () => {
    const data = Buffer.alloc(31, 0xab)
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
  })

  it('pads short data to 33 bytes', async () => {
    const data = Buffer.from([0x01, 0x02, 0x03])
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
    // Original data follows the 0x02 prefix
    assert.strictEqual(result[1], 0x01)
    assert.strictEqual(result[2], 0x02)
    assert.strictEqual(result[3], 0x03)
  })

  it('handles exactly 32 bytes of data', async () => {
    const data = Buffer.alloc(32, 0xff)
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
  })
})
