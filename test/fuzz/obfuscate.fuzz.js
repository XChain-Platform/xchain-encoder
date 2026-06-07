/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz: obfuscate() round-trip invariant
 *
 * Property-based via the repo's iterative-loop idiom (no fast-check dep):
 * for thousands of random (payload, TXID) pairs, obfuscate() must
 *   (1) never throw on a well-formed 64-hex key,
 *   (2) preserve length (AES-128-CTR is a stream cipher), and
 *   (3) round-trip exactly back to the plaintext via deobfuscate().
 * Any violation is collected with its inputs so a failure is reproducible.
 */

const assert = require('assert')
const crypto = require('crypto')
const XChainEncoder = require('../../src/XChainEncoder')
const { deobfuscate } = require('../integration/helpers/deobfuscate')

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS || 2000)

function makeTestEncoder () {
    return new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
}

describe('Fuzz: obfuscate()', function () {
    this.timeout(120000)
    const encoder = makeTestEncoder()

    it(`round-trips and preserves length over ${ITERATIONS} random (data, txid) pairs`, async () => {
        const failures = []
        for (let i = 0; i < ITERATIONS; i++) {
            const data = crypto.randomBytes(crypto.randomInt(0, 1024))
            const txid = crypto.randomBytes(32).toString('hex') // well-formed 64-hex key material
            let out
            try {
                out = await encoder.obfuscate(data, txid)
            } catch (err) {
                failures.push({ i, reason: 'threw', err: err.message, size: data.length, txid })
                continue
            }
            if (out.length !== data.length) {
                failures.push({ i, reason: 'length', got: out.length, want: data.length, txid })
                continue
            }
            if (!deobfuscate(out, txid).equals(data)) {
                failures.push({ i, reason: 'roundtrip', size: data.length, txid })
            }
        }
        assert.strictEqual(failures.length, 0,
            `obfuscate() invariants violated in ${failures.length}/${ITERATIONS} cases: ${JSON.stringify(failures.slice(0, 5))}`)
    })
})
