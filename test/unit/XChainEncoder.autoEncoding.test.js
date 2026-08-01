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
 *  S5: the two default flips (spec §5.2, §6, §7).
 *
 * 1. Size-aware encoding selection behind the caller's explicit AUTO opt-in.
 *    The load-bearing assertions are the ones about what does NOT change:
 *    a caller who passes no encoding must still get exactly today's bytes,
 *    because auto-selecting TAPROOT turns one PSBT into a commit/reveal pair
 *    and no existing caller is ready for that.
 *
 * 2. Compression ON by default, tri-state. The subtle half is that the
 *    default pass must ride raw where an explicit request must throw:
 *    otherwise turning the default on breaks every action that carries
 *    rawData but cannot carry the COMPRESSION marker.
 */

'use strict'

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')

const XChainEncoder = require('../../src/XChainEncoder')
const validator = require('../../src/validator')
const compression = require('../../src/compression')

bitcoin.initEccLib(ecc)

const PRIV = Buffer.alloc(32, 9)
const PUB = Buffer.from(ecc.pointFromScalar(PRIV, true))
const PUBKEY_HEX = PUB.toString('hex')

function makeEncoder(network = 'bitcoin-regtest') {
    const encoder = new XChainEncoder(network, '127.0.0.1', '0', 'x', 'x', '', '')
    encoder.connector = {
        getFeePerKilobyte: async () => 0.00002,
        getTransactionHex: async () => { throw new Error('not needed') }
    }
    encoder.utxoTrackerConnector = {
        getUtxosFromAddress: async () => { throw new Error('utxos are supplied explicitly') }
    }
    return encoder
}

function callerAddress(network) {
    return bitcoin.payments.p2wpkh({ pubkey: PUB, network }).address
}

function segwitUtxo(network, value = 5000000000) {
    return {
        txid: 'a'.repeat(64), vout: 0, value, confirmations: 101,
        scriptPubKey: bitcoin.payments.p2wpkh({ pubkey: PUB, network }).output.toString('hex')
    }
}

// Compressible without tripping the 150:1 emit-time guard.
function compressibleText(n) {
    let out = ''
    let i = 0
    while (Buffer.byteLength(out) < n) {
        out += `2026-07-31 INFO worker[${i % 7}] batch ${i} elapsed=${i % 97}ms status=ok\n`
        i++
    }
    return out.slice(0, n)
}

const FILE_ACTION = 'FILE|0|report.log|text/plain|Report|memo'

describe(' S5: size-aware encoding selection (§6)', function () {

    describe('selectEncoding', function () {
        const opts = { signerSupportsTapscript: true }

        it('picks OP_RETURN up to the single-output ceiling, and leaves it one byte later', function () {
            const e = makeEncoder()
            assert.strictEqual(e.selectEncoding(76, PUBKEY_HEX, opts), 'OP_RETURN')
            assert.strictEqual(e.selectEncoding(77, PUBKEY_HEX, opts), 'TAPROOT')
        })

        it('picks TAPROOT for a large payload on a Taproot chain with a capable signer', function () {
            assert.strictEqual(makeEncoder().selectEncoding(5000, PUBKEY_HEX, opts), 'TAPROOT')
            assert.strictEqual(makeEncoder('litecoin-regtest').selectEncoding(5000, PUBKEY_HEX, opts), 'TAPROOT')
        })

        it('falls back to P2WSH when the signer cannot sign a tapscript spend', function () {
            // The fail-closed direction, and the reason is not tidiness: the
            // reveal must be signable BEFORE the commit is broadcast, so
            // choosing the envelope for a signer that cannot spend it produces
            // stranded funds rather than an error message.
            const e = makeEncoder()
            assert.strictEqual(e.selectEncoding(5000, PUBKEY_HEX, {}), 'P2WSH')
            assert.strictEqual(e.selectEncoding(5000, PUBKEY_HEX, null), 'P2WSH')
            assert.strictEqual(e.selectEncoding(5000, PUBKEY_HEX, { signerSupportsTapscript: false }), 'P2WSH')
        })

        it('falls back to P2WSH with no pubkey to use as the envelope internal key', function () {
            assert.strictEqual(makeEncoder().selectEncoding(5000, null, opts), 'P2WSH')
        })

        it('picks P2SH on a non-segwit chain, never the worst-density MULTISIGN lane', function () {
            const doge = makeEncoder('dogecoin-regtest')
            assert.strictEqual(doge.selectEncoding(5000, PUBKEY_HEX, opts), 'P2SH')
            assert.strictEqual(doge.selectEncoding(60, PUBKEY_HEX, opts), 'OP_RETURN')
        })
    })

    describe('through createTransaction', function () {
        it('AUTO returns the commit/reveal pair when it selects TAPROOT', async function () {
            const e = makeEncoder()
            const network = e.network
            const result = await e.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION,
                compressibleText(6000), null, false, 'AUTO', callerAddress(network),
                null, null, PUBKEY_HEX, true, null, null, null, false, false,
                { signerSupportsTapscript: true })
            assert.strictEqual(result.encoding, 'TAPROOT')
            assert.ok(result.revealPsbt, 'the two-tx response shape')
            assert.ok(result.envelope && result.envelope.tapleafHash, 'the recovery record')
        })

        it('AUTO returns a single PSBT when it selects P2WSH', async function () {
            const e = makeEncoder()
            const network = e.network
            const result = await e.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION,
                compressibleText(6000), null, false, 'AUTO', callerAddress(network),
                null, null, PUBKEY_HEX, true, null, null, null, false, false)
            assert.strictEqual(result.encoding, 'P2WSH')
            assert.strictEqual(result.revealPsbt, undefined)
        })

        it('AUTO refuses an over-cap payload rather than splitting it across envelopes', async function () {
            const e = makeEncoder()
            const network = e.network
            // Incompressible bytes above the envelope ceiling: §6's over-cap
            // branch is a hard error naming the cap, never a ~820-output spray.
            const oversize = require('crypto').randomBytes(400100).toString('binary')
            await assert.rejects(
                e.createTransaction(
                    [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION, oversize,
                    null, false, 'AUTO', callerAddress(network),
                    null, null, PUBKEY_HEX, true, null, null, null, false, false,
                    { signerSupportsTapscript: true }),
                (err) => err instanceof RangeError && /exceeds maximum 400000/.test(err.message))
        })

        it('leaves the legacy no-encoding path exactly as shipped', async function () {
            // The whole point of the opt-in. A caller who passes no encoding
            // gets OP_RETURN or P2SH, never TAPROOT, and never a reveal PSBT to
            // handle, even with a tapscript-capable signer declared.
            const e = makeEncoder()
            const network = e.network
            const small = await e.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, 'SEND|0|TOK|1|' + callerAddress(network) + '|m',
                null, null, false, null, callerAddress(network),
                null, null, PUBKEY_HEX, true, null, null, null, false, false,
                { signerSupportsTapscript: true })
            assert.strictEqual(small.encoding, 'OP_RETURN')
            assert.strictEqual(small.revealPsbt, undefined)

            const large = await e.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION,
                compressibleText(6000), null, false, null, callerAddress(network),
                null, null, PUBKEY_HEX, true, null, null, null, false, false,
                { signerSupportsTapscript: true })
            assert.strictEqual(large.encoding, 'P2SH')
            assert.strictEqual(large.revealPsbt, undefined)
        })
    })

    describe('validator', function () {
        function base(extra) {
            return Object.assign({
                utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100000, scriptPubKey: '0014' + 'bb'.repeat(20) }],
                pubkey: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef',
                data: FILE_ACTION,
                change: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'
            }, extra || {})
        }

        it('accepts AUTO as an encoding', function () {
            assert.strictEqual(validator.validateAll(base({ encoding: 'AUTO' })).encoding, 'AUTO')
        })

        it('accepts the options bag and refuses unknown keys', function () {
            const ok = validator.validateAll(base({ options: { signerSupportsTapscript: true } }))
            assert.strictEqual(ok.options.signerSupportsTapscript, true)
            assert.strictEqual(validator.validateAll(base({})).options, null)
            // A misspelled capability that silently meant "no" would send an
            // envelope-capable signer down the 2x-cost lane with no signal.
            assert.throws(() => validator.validateAll(base({ options: { signerSupportsTaproot: true } })),
                /Unknown options key/)
            assert.throws(() => validator.validateAll(base({ options: { signerSupportsTapscript: 'yes' } })),
                /signerSupportsTapscript/)
            assert.throws(() => validator.validateAll(base({ options: [] })), /options must be an object/)
        })

        it('does not require compressedPubKey for AUTO (it degrades instead)', function () {
            assert.doesNotThrow(() => validator.validateAll(base({ encoding: 'AUTO' })))
        })
    })
})

describe(' S5: compression ON by default (§5.2/§7)', function () {

    afterEach(function () { delete process.env.XCHAIN_COMPRESSION_DEFAULT })

    it('compresses a FILE with no flag passed, and reports what it did', async function () {
        const e = makeEncoder()
        const network = e.network
        const result = await e.createTransaction(
            [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION,
            compressibleText(20000), null, false, 'P2WSH', callerAddress(network))
        assert.strictEqual(result.compression.compressed, true)
        assert.strictEqual(result.compression.rawLength, 20000)
        assert.ok(result.compression.storedLength < 20000)
    })

    it('the deploy-time lever turns the default off without a code change', async function () {
        // Spec §7's two-step needs the code release and the behaviour change to
        // land separately: readers everywhere first, encoder default second.
        process.env.XCHAIN_COMPRESSION_DEFAULT = '0'
        const e = makeEncoder()
        const network = e.network
        const result = await e.createTransaction(
            [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION,
            compressibleText(6000), null, false, 'P2WSH', callerAddress(network))
        assert.strictEqual(result.compression, undefined, 'compression never ran')
    })

    it('an explicit false still opts out', async function () {
        const e = makeEncoder()
        const network = e.network
        const result = await e.createTransaction(
            [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION,
            compressibleText(6000), null, false, 'P2WSH', callerAddress(network),
            null, null, null, true, null, null, null, false, false)
        assert.strictEqual(result.compression, undefined)
    })

    describe('the default pass rides raw where an explicit request throws', function () {
        const GATED = 'FILE|0|secret.enc|application/octet-stream|Secret||MYTOKEN|1|' + 'a'.repeat(64)
        const cases = [
            ['a non-FILE action', 'SEND|0|TOK|1|mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef|m', 'not-a-file-action'],
            ['a token-gated FILE', GATED, 'gated-file'],
            ['an action that already declares a codec', compression.withCompressionField(FILE_ACTION, '1'), 'codec-already-declared']
        ]

        for (const [label, action, reason] of cases) {
            it(`${label}: the default pass builds and reports "${reason}"`, async function () {
                const e = makeEncoder()
                const network = e.network
                const result = await e.createTransaction(
                    [segwitUtxo(network)], callerAddress(network), null, action,
                    compressibleText(3000), null, false, 'P2WSH', callerAddress(network))
                assert.strictEqual(result.compression.compressed, false)
                assert.strictEqual(result.compression.reason, reason)
            })

            it(`${label}: an explicit request still fails closed`, async function () {
                const e = makeEncoder()
                const network = e.network
                await assert.rejects(
                    e.createTransaction(
                        [segwitUtxo(network)], callerAddress(network), null, action,
                        compressibleText(3000), null, false, 'P2WSH', callerAddress(network),
                        null, null, null, true, null, null, null, false, true),
                    /Compression requested/)
            })
        }
    })

    it('compression can make a payload fit a lane it would otherwise overflow', async function () {
        // A real consequence of the flip, worth stating rather than discovering:
        // 20 KB of text exceeds the 8,192-byte legacy ceiling uncompressed and
        // is refused, but rides the same lane once compressed. The ceiling is
        // checked against the bytes that will actually be written (§5.2: the
        // estimator and every gate run AFTER compression).
        const e = makeEncoder()
        const network = e.network
        const payload = compressibleText(20000)

        const compressed = await e.createTransaction(
            [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION, payload,
            null, false, 'P2WSH', callerAddress(network))
        assert.strictEqual(compressed.compression.compressed, true)

        await assert.rejects(
            e.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, FILE_ACTION, payload,
                null, false, 'P2WSH', callerAddress(network),
                null, null, null, true, null, null, null, false, false),
            (err) => err instanceof RangeError && /exceeds maximum 8192/.test(err.message))
    })

    it('turning the default on does not break an ordinary SEND carrying rawData', async function () {
        // The regression this whole tri-state exists to prevent.
        const e = makeEncoder()
        const network = e.network
        const result = await e.createTransaction(
            [segwitUtxo(network)], callerAddress(network), null,
            'SEND|0|TOK|1|' + callerAddress(network) + '|m', 'some raw bytes',
            null, false, 'P2WSH', callerAddress(network))
        assert.ok(result.psbt, 'built normally')
        assert.strictEqual(result.compression.compressed, false)
    })
})
