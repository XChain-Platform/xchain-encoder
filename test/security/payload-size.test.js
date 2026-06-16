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
 * Security: on-chain payload-size ceiling
 *
 * Every indexing node drops a transaction whose compiled ACTION push
 * exceeds MAX_COMPILED_ACTION_DATA_LENGTH. If the encoder let an over-size
 * payload through, the caller would broadcast (and pay for) a transaction
 * that the network silently discards. createTransaction() must reject it at
 * encode time. This attacks that ceiling end-to-end through the real builder.
 */

const assert = require('assert')
const {
    TXID_A,
    makeSegwitUtxo,
    makeEncoder,
    getTestAddress
} = require('../integration/helpers/utxoFactory')
const { MAX_COMPILED_ACTION_DATA_LENGTH } = require('../../src/validator')

const NETWORK = 'dogecoin-regtest'

describe('Security: compiled payload-size ceiling', () => {
    let encoder, address, utxo

    before(() => {
        encoder = makeEncoder(NETWORK)
        address = getTestAddress(NETWORK)
        utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
    })

    it('rejects a payload whose compiled push exceeds the on-chain ceiling', async () => {
        // A raw N-byte payload (N >= 256) compiles to N + 3 bytes (OP_PUSHDATA2
        // + 2-byte length), so this is comfortably over the 8192 ceiling.
        const oversize = 'X'.repeat(MAX_COMPILED_ACTION_DATA_LENGTH + 64)
        await assert.rejects(
            () => encoder.createTransaction(
                [utxo], address, null, oversize, null, null, false,
                null, address, null, null, null, true, 1
            ),
            /Payload too large|exceeds maximum/
        )
    })

    it('does not reject a small payload at the size guard', async () => {
        // A tiny payload must clear the size guard. (It may still fail later in
        // the build for unrelated reasons; we only assert it is NOT the
        // "Payload too large" rejection.)
        try {
            await encoder.createTransaction(
                [utxo], address, null, 'SEND|0|X|1|a', null, null, false,
                null, address, null, null, null, true, 1
            )
        } catch (err) {
            assert.ok(
                !/Payload too large/.test(err.message),
                `small payload must not trip the size guard, got: ${err.message}`
            )
        }
    })
})
