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
 * Security: obfuscation key binding
 *
 * obfuscate() derives an AES-128-CTR key+IV from the first input's TXID
 * (key = txid[0..16), iv = txid[16..32)). Security properties under test:
 *   - a malformed/short key fails closed (controlled throw, no hang/partial
 *     cipher),
 *   - the payload is actually transformed (never emitted in the clear),
 *   - the output is bound to the TXID: a different TXID does NOT recover
 *     the plaintext (no trivial deobfuscation without the key material).
 */

const assert = require('assert')
const XChainEncoder = require('../../src/XChainEncoder')
const { deobfuscate } = require('../integration/helpers/deobfuscate')

const TXID_1 = 'a'.repeat(64)
const TXID_2 = 'b'.repeat(64)

function makeTestEncoder () {
    return new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
}

describe('Security: obfuscation key binding', () => {
    const encoder = makeTestEncoder()

    it('fails closed on a too-short key (invalid key/IV length)', async () => {
        await assert.rejects(() => encoder.obfuscate(Buffer.from('payload'), 'deadbeef'))
    })

    it('fails closed on an empty key', async () => {
        await assert.rejects(() => encoder.obfuscate(Buffer.from('payload'), ''))
    })

    it('actually transforms the payload (not emitted in the clear)', async () => {
        const data = Buffer.from('SEND|0|TESTTOKEN|1000|recipient-address', 'utf8')
        const out = await encoder.obfuscate(data, TXID_1)
        assert.ok(!out.equals(data), 'ciphertext must differ from plaintext')
        assert.strictEqual(out.length, data.length, 'CTR mode preserves length')
    })

    it('binds the ciphertext to the TXID: a different TXID does not recover it', async () => {
        const data = Buffer.from('confidential action payload', 'utf8')
        const out = await encoder.obfuscate(data, TXID_1)

        // Correct TXID recovers the plaintext exactly.
        assert.deepStrictEqual(deobfuscate(out, TXID_1), data)

        // A different TXID yields garbage, not the plaintext.
        const wrong = deobfuscate(out, TXID_2)
        assert.ok(!wrong.equals(data), 'wrong TXID must not recover the plaintext')
    })

    it('produces distinct ciphertext for the same data under different TXIDs', async () => {
        const data = Buffer.from('same data, different key', 'utf8')
        const a = await encoder.obfuscate(data, TXID_1)
        const b = await encoder.obfuscate(data, TXID_2)
        assert.ok(!a.equals(b), 'key material must influence the ciphertext')
    })
})
