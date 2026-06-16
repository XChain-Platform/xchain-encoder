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
 * Fuzz: dataToPubkey() structure invariant
 *
 * dataToPubkey() packs a data chunk into a 33-byte pubkey-shaped buffer for
 * MULTISIGN carriers: a 0x02 prefix followed by the data, zero-padded to 32
 * bytes when the chunk is short. Over random chunk sizes the invariants are:
 *   - always begins with 0x02,
 *   - a chunk <= 32 bytes yields exactly 33 bytes (data then zero pad),
 *   - a chunk > 32 bytes yields 1 + len bytes (prefix then data, no pad).
 */

const assert = require('assert')
const crypto = require('crypto')
const XChainEncoder = require('../../src/XChainEncoder')

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS || 2000)

function makeTestEncoder () {
    return new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
}

describe('Fuzz: dataToPubkey()', function () {
    this.timeout(120000)
    const encoder = makeTestEncoder()

    it(`holds the pubkey-shape invariant over ${ITERATIONS} random chunks`, async () => {
        const failures = []
        for (let i = 0; i < ITERATIONS; i++) {
            const size = crypto.randomInt(0, 40) // span the 32-byte pad boundary
            const data = crypto.randomBytes(size)
            const out = await encoder.dataToPubkey(data)

            if (out[0] !== 0x02) { failures.push({ i, reason: 'prefix', size, got: out[0] }); continue }

            if (size <= 32) {
                if (out.length !== 33) { failures.push({ i, reason: 'len<=32', size, got: out.length }); continue }
                if (!out.subarray(1, 1 + size).equals(data)) { failures.push({ i, reason: 'data<=32', size }); continue }
                // remainder must be zero padding
                if (out.subarray(1 + size).some(b => b !== 0)) failures.push({ i, reason: 'pad', size })
            } else {
                if (out.length !== 1 + size) { failures.push({ i, reason: 'len>32', size, got: out.length }); continue }
                if (!out.subarray(1).equals(data)) failures.push({ i, reason: 'data>32', size })
            }
        }
        assert.strictEqual(failures.length, 0,
            `dataToPubkey() invariants violated in ${failures.length}/${ITERATIONS} cases: ${JSON.stringify(failures.slice(0, 5))}`)
    })
})
