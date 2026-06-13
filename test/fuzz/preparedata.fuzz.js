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
 * Fuzz: prepareData() chunking invariants
 *
 * prepareData() splits an arbitrary payload into carrier-sized chunks. Over
 * random payload sizes the invariants are:
 *   - OP_RETURN: every chunk is prefixed with the XCHN magic, and stripping
 *     the magic and concatenating recovers the original payload exactly.
 *   - MULTISIGN: every chunk is a full 64-byte slot prefixed with the magic.
 *   - P2SH: compilation never throws for arbitrary bytes (with a valid pubkey).
 */

const assert = require('assert')
const crypto = require('crypto')
const XChainEncoder = require('../../src/XChainEncoder')
const { MAGIC_WORD } = require('../integration/helpers/deobfuscate')
const { getTestAddress } = require('../integration/helpers/utxoFactory')

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS || 1500)
const MAGIC = Buffer.from(MAGIC_WORD, 'utf8')

function makeTestEncoder () {
    return new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
}

describe('Fuzz: prepareData()', function () {
    this.timeout(120000)
    const encoder = makeTestEncoder()

    // A transaction may carry at most one OP_RETURN output (Bitcoin Core
    // rejects multi-OP_RETURN as non-standard), so OP_RETURN holds exactly one
    // chunk: payloads <= 76 bytes produce a single magic-prefixed output that
    // reassembles exactly; payloads > 76 bytes are rejected with a RangeError.
    const OP_RETURN_MAX = 80 - MAGIC.length // 76
    it(`OP_RETURN produces one magic-prefixed chunk at/under the limit over ${ITERATIONS} payloads`, () => {
        const failures = []
        for (let i = 0; i < ITERATIONS; i++) {
            const data = crypto.randomBytes(crypto.randomInt(1, OP_RETURN_MAX + 1)) // 1..76
            const { dataBufferArray } = encoder.prepareData(data, 'OP_RETURN', null)
            if (dataBufferArray.length !== 1) { failures.push({ i, reason: 'chunk-count', got: dataBufferArray.length, size: data.length }); continue }
            if (!dataBufferArray[0].subarray(0, 4).equals(MAGIC)) { failures.push({ i, reason: 'magic', size: data.length }); continue }
            if (!dataBufferArray[0].subarray(4).equals(data)) failures.push({ i, reason: 'reassembly', size: data.length })
        }
        assert.strictEqual(failures.length, 0,
            `OP_RETURN chunking violated in ${failures.length}/${ITERATIONS}: ${JSON.stringify(failures.slice(0, 5))}`)
    })

    it(`OP_RETURN rejects oversized payloads over ${ITERATIONS} payloads`, () => {
        const failures = []
        for (let i = 0; i < ITERATIONS; i++) {
            const data = crypto.randomBytes(crypto.randomInt(OP_RETURN_MAX + 1, 2048)) // 77..2047
            try {
                encoder.prepareData(data, 'OP_RETURN', null)
                failures.push({ i, reason: 'no-throw', size: data.length })
            } catch (err) {
                if (!(err instanceof RangeError)) failures.push({ i, reason: 'wrong-error', err: err.message, size: data.length })
            }
        }
        assert.strictEqual(failures.length, 0,
            `OP_RETURN oversize guard violated in ${failures.length}/${ITERATIONS}: ${JSON.stringify(failures.slice(0, 5))}`)
    })

    it(`MULTISIGN chunks are full 64-byte magic-prefixed slots over ${ITERATIONS} payloads`, () => {
        const failures = []
        for (let i = 0; i < ITERATIONS; i++) {
            const data = crypto.randomBytes(crypto.randomInt(1, 1024))
            const { dataBufferArray } = encoder.prepareData(data, 'MULTISIGN', null)
            for (const c of dataBufferArray) {
                if (c.length !== 64) { failures.push({ i, reason: 'slot-size', got: c.length, size: data.length }); break }
                if (!c.subarray(0, 4).equals(MAGIC)) { failures.push({ i, reason: 'magic', size: data.length }); break }
            }
        }
        assert.strictEqual(failures.length, 0,
            `MULTISIGN chunking violated in ${failures.length}/${ITERATIONS}: ${JSON.stringify(failures.slice(0, 5))}`)
    })

    it(`P2SH compilation never throws over ${ITERATIONS} payloads`, () => {
        const pubKey = getTestAddress('dogecoin-regtest')
        const failures = []
        for (let i = 0; i < ITERATIONS; i++) {
            const data = crypto.randomBytes(crypto.randomInt(0, 2048))
            try {
                const { dataBufferArray } = encoder.prepareData(data, 'P2SH', pubKey)
                if (!Array.isArray(dataBufferArray)) failures.push({ i, reason: 'not-array', size: data.length })
            } catch (err) {
                failures.push({ i, reason: 'threw', err: err.message, size: data.length })
            }
        }
        assert.strictEqual(failures.length, 0,
            `P2SH chunking violated in ${failures.length}/${ITERATIONS}: ${JSON.stringify(failures.slice(0, 5))}`)
    })
})
