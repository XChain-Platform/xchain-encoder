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
 * Emit-side FILE payload compression (spec Part B), encoder side.
 *
 * The load-bearing assertions here are the REFUSALS. Compression is opt-in and
 * mutates the published ACTION string, so every way it could publish
 * permanently unreadable bytes has to fail closed BEFORE broadcast:
 *  - a non-FILE action has nowhere to record the marker;
 *  - a GATED FILE's COMPRESSION field means inflate-after-decrypt and belongs
 *    to the client that did compress-then-encrypt, never to the encoder;
 *  - a caller-declared codec is never silently re-compressed;
 *  - hyper-compressible payloads are emitted raw, because a compliant reader
 *    would refuse to inflate them (emit-time mirror of the serve guard).
 *
 * Plus the two properties that make the feature safe to ship dark:
 *  - the default (ON, per spec §5.2) and the explicit opt-out;
 *  - the estimator prices the COMPRESSED bytes, not the caller's original.
 */

'use strict'

const assert = require('assert')
const crypto = require('crypto')
const zlib = require('zlib')
const path = require('path')
const fs = require('fs')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')

const XChainEncoder = require('../../src/XChainEncoder')
const compression = require('../../src/compression')
const validator = require('../../src/validator')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY = Buffer.from(KEY.publicKey)
const TXID_A = 'a'.repeat(64)

const PUBLIC_FILE = 'FILE|0|report.txt|text/plain|Report|memo'
const GATED_FILE = 'FILE|0|secret.enc|application/octet-stream|Secret||MYTOKEN|1|' + 'a'.repeat(64)

// Realistically compressible: JSON-ish records compress ~4-5:1, which is a
// real-world FILE profile AND comfortably inside the 150:1 guard. Naive
// repeated text is a bad fixture here: it compresses ~210:1 and would trip the
// emit-time ratio guard, so it exercises a different branch than intended.
function compressibleBytes(n = 40000) {
    let out = ''
    for (let i = 0; out.length < n; i++)
        out += JSON.stringify({ id: i, name: 'item-' + i, value: (i * 7919) % 100000, ok: i % 3 === 0 }) + '\n'
    return Buffer.from(out.slice(0, n), 'utf8')
}

function makeEncoder(networkName = 'bitcoin-regtest') {
    const encoder = new XChainEncoder(networkName, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
    encoder.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => { throw new Error('unit test: no node') }
    }
    encoder.utxoTrackerConnector = {
        getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
    }
    return encoder
}

function segwitUtxo(network, value = 10000000) {
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network })
    return { txid: TXID_A, vout: 0, value, confirmations: 6, scriptPubKey: p2wpkh.output.toString('hex') }
}

function callerAddress(network) {
    return bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network }).address
}

describe('encoder FILE payload compression (spec Part B)', function () {

    describe('compressPayloadForAction', function () {

        it('compresses a public FILE payload and appends the COMPRESSION field', async function () {
            const payload = compressibleBytes()
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, payload)
            assert.strictEqual(r.compressed, true)
            assert.ok(r.storedLength < r.rawLength)
            assert.strictEqual(r.data, PUBLIC_FILE + '|||||1')
            assert.strictEqual(compression.compressionFieldOf(r.data), '1')
            // The bytes are genuinely deflate-raw and reconstruct exactly.
            assert.ok(zlib.inflateRawSync(r.rawData).equals(payload))
        })

        it('the marker and the bytes always move together', async function () {
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, compressibleBytes())
            const declaredCompressed = compression.compressionFieldOf(r.data) === '1'
            assert.strictEqual(declaredCompressed, r.compressed,
                'a marker without compressed bytes (or vice versa) publishes unreadable data')
        })

        it('keeps already-compressed media raw, leaving the action byte-identical', async function () {
            const media = crypto.randomBytes(20000)
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, media)
            assert.strictEqual(r.compressed, false)
            assert.strictEqual(r.reason, 'not-smaller')
            assert.strictEqual(r.data, PUBLIC_FILE, 'no COMPRESSION field appended')
            assert.ok(r.rawData.equals(media))
        })

        it('emits RAW when the payload compresses beyond the ratio guard', async function () {
            // A compliant reader would refuse to inflate this, so emitting it
            // compressed would spend real money on unreadable bytes.
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, Buffer.alloc(200000, 0x20))
            assert.strictEqual(r.compressed, false)
            assert.strictEqual(r.reason, 'ratio-guard')
            assert.strictEqual(r.data, PUBLIC_FILE)
        })

        it('passes a payload-free action straight through', async function () {
            const r = await compression.compressPayloadForAction(PUBLIC_FILE, Buffer.alloc(0))
            assert.strictEqual(r.compressed, false)
            assert.strictEqual(r.reason, 'no-payload')
            assert.strictEqual(r.data, PUBLIC_FILE)
        })

        // --- the refusals ---

        it('REFUSES a non-FILE action (nowhere to record the marker)', async function () {
            await assert.rejects(
                () => compression.compressPayloadForAction('SEND|0|XCHAIN|1000', compressibleBytes()),
                /COMPRESSION is a FILE v0 field/
            )
        })

        it('REFUSES a FILE of another version', async function () {
            await assert.rejects(
                () => compression.compressPayloadForAction('FILE|1|a.txt|text/plain', compressibleBytes()),
                /COMPRESSION is a FILE v0 field/
            )
        })

        it('REFUSES a token-gated FILE (§5.4: the field means inflate-after-decrypt)', async function () {
            // The trap this guards: on a gated FILE, COMPRESSION describes the
            // PLAINTEXT the client compressed before encrypting. If the encoder
            // also compressed the ciphertext and set the same field, a reader
            // would try to inflate ciphertext.
            await assert.rejects(
                () => compression.compressPayloadForAction(GATED_FILE, compressibleBytes()),
                /token-gated FILE/
            )
        })

        it('REFUSES to re-compress when the caller already declared a codec', async function () {
            await assert.rejects(
                () => compression.compressPayloadForAction(PUBLIC_FILE + '|||||1', compressibleBytes()),
                /already declares COMPRESSION/
            )
        })

        it('REFUSES a payload over the pre-compression input cap', async function () {
            await assert.rejects(
                () => compression.compressPayloadForAction(PUBLIC_FILE, Buffer.alloc(2048),
                    { maxInputBytes: 1024 }),
                /exceeds the 1024-byte compression input cap/
            )
        })

        it('a gated FILE passes its own COMPRESSION field through untouched', function () {
            // The client set it; the encoder must neither add nor remove it.
            const clientSet = GATED_FILE + '|100|1'
            assert.strictEqual(compression.compressionFieldOf(clientSet), '1')
            assert.strictEqual(compression.isGatedFileAction(clientSet), true)
        })
    })

    describe('action-string helpers', function () {
        it('detects FILE v0 and gating correctly', function () {
            assert.strictEqual(compression.isFileV0Action(PUBLIC_FILE), true)
            assert.strictEqual(compression.isFileV0Action('SEND|0|X|1'), false)
            assert.strictEqual(compression.isFileV0Action('FILE|1|a|b'), false)
            assert.strictEqual(compression.isGatedFileAction(GATED_FILE), true)
            assert.strictEqual(compression.isGatedFileAction(PUBLIC_FILE), false)
        })

        it('setting the field empty leaves the action byte-identical', function () {
            assert.strictEqual(compression.withCompressionField(PUBLIC_FILE, ''), PUBLIC_FILE)
        })

        it('pads intermediate optional fields to reach index 10', function () {
            const out = compression.withCompressionField('FILE|0|a.txt|text/plain', '1')
            assert.strictEqual(out.split('|').length, 11)
            assert.strictEqual(out.split('|')[10], '1')
        })

        it('preserves the gating fields when a client sets the marker', function () {
            const out = compression.withCompressionField(GATED_FILE + '|100', '1')
            const parts = out.split('|')
            assert.strictEqual(parts[6], 'MYTOKEN')
            assert.strictEqual(parts[7], '1')
            assert.strictEqual(parts[9], '100')
            assert.strictEqual(parts[10], '1')
        })
    })

    describe('createTransaction integration', function () {

        // The default is ON (spec §5.2/§7). The assertion also had to
        // change in KIND: the previous version inspected the input constant,
        // which proved nothing about what the encoder built and would have
        // passed whichever way the default went. It now reads the encoder's own
        // report of what it did.
        it('compresses by DEFAULT, with no compress flag passed at all', async function () {
            const encoder = makeEncoder()
            const network = encoder.network
            const payload = compressibleBytes(2000).toString('binary')

            const result = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, PUBLIC_FILE, payload,
                null, false, 'P2WSH', callerAddress(network))

            assert.ok(result.compression, 'the build reports what compression did')
            assert.strictEqual(result.compression.compressed, true, 'compressed without being asked')
            assert.ok(result.compression.storedLength < result.compression.rawLength,
                'stored fewer bytes than the caller handed in')
        })

        it('honours an explicit opt-out', async function () {
            const encoder = makeEncoder()
            const network = encoder.network
            const payload = compressibleBytes(2000).toString('binary')

            const result = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null, PUBLIC_FILE, payload,
                null, false, 'P2WSH', callerAddress(network), null, null, null,
                true, null, null, null, false, false)

            assert.strictEqual(result.compression, undefined,
                'compression never ran, so there is nothing to report')
        })

        it('compresses when opted in, and the estimator prices the COMPRESSED bytes', async function () {
            const encoder = makeEncoder()
            const network = encoder.network
            const raw = compressibleBytes(30000)

            // Same payload, once raw and once compressed, through the same lane.
            const uncompressed = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null,
                'FILE|0|big.txt|text/plain|Big|', raw.toString('binary'),
                null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY.toString('hex'),
                true, null, null, null, false, false)

            // Same input on purpose: release the first build's reservation so the
            // second is a rebuild for comparison, not a refused double-spend.
            encoder.clearReservations()
            const compressed = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null,
                'FILE|0|big.txt|text/plain|Big|', raw.toString('binary'),
                null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY.toString('hex'),
                true, null, null, null, false, true)

            // The envelope carries the payload in its witness; a compressed
            // payload must produce a materially smaller reveal.
            const rawScript = Buffer.from(uncompressed.carrierScripts[0], 'hex')
            const compScript = Buffer.from(compressed.carrierScripts[0], 'hex')
            assert.ok(compScript.length < rawScript.length / 2,
                `compressed envelope (${compScript.length}) should be far smaller than raw (${rawScript.length})`)

            // The fee the estimator prefunded tracks the compressed reveal, not
            // the caller's original payload size.
            assert.ok(compressed.envelope.revealFee < uncompressed.envelope.revealFee,
                'the quoted reveal fee reflects the bytes actually written')
        })

        it('the compressed transaction carries the marker AND reconstructs byte-exactly', async function () {
            const encoder = makeEncoder()
            const network = encoder.network
            const raw = compressibleBytes(20000)

            const result = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null,
                'FILE|0|doc.txt|text/plain|Doc|', raw.toString('binary'),
                null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY.toString('hex'),
                true, null, null, null, false, true)

            // Pull the payload back out of the envelope script and invert it,
            // exactly as a reader would.
            const script = Buffer.from(result.carrierScripts[0], 'hex')
            const decompiled = bitcoin.script.decompile(script)
            const endifIndex = decompiled.lastIndexOf(bitcoin.opcodes.OP_ENDIF)
            const payload = Buffer.concat(decompiled.slice(4, endifIndex))
            const pushes = bitcoin.script.decompile(payload)

            const actionString = pushes[0].toString('utf8')
            assert.strictEqual(compression.compressionFieldOf(actionString), '1',
                'the on-chain action string declares deflate-raw')
            assert.ok(zlib.inflateRawSync(pushes[1]).equals(raw),
                'the on-chain bytes inflate back to the caller\'s original payload')
        })

        it('refuses at build time when a gated FILE asks for encoder-side compression', async function () {
            const encoder = makeEncoder()
            const network = encoder.network
            await assert.rejects(
                () => encoder.createTransaction(
                    [segwitUtxo(network)], callerAddress(network), null, GATED_FILE,
                    compressibleBytes(2000).toString('binary'),
                    null, false, 'P2WSH', callerAddress(network), null, null, null,
                    true, null, null, null, false, true),
                /token-gated FILE/
            )
        })

        it('an incompressible payload opted in still builds, just uncompressed', async function () {
            const encoder = makeEncoder()
            const network = encoder.network
            const media = crypto.randomBytes(3000).toString('binary')
            const result = await encoder.createTransaction(
                [segwitUtxo(network)], callerAddress(network), null,
                'FILE|0|photo.jpg|image/jpeg|Photo|', media,
                null, false, 'P2WSH', callerAddress(network), null, null, null,
                true, null, null, null, false, true)
            assert.ok(result.psbt, 'still produces a transaction')
        })
    })

    describe('validator', function () {
        it('accepts compress as an optional boolean; absent means "use the deployment default"', function () {
            const base = {
                utxos: [{ txid: TXID_A, vout: 0, value: 100000, scriptPubKey: '0014' + 'bb'.repeat(20) }],
                pubkey: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef',
                data: PUBLIC_FILE,
                change: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'
            }
            // Absent stays absent through the validator: the tri-state is
            // resolved in the encoder, which is the only place that knows the
            // deployment default.
            assert.strictEqual(validator.validateAll({ ...base }).compress, undefined, 'absent stays absent');
            assert.strictEqual(validator.validateAll({ ...base, compress: true }).compress, true);
            assert.strictEqual(validator.validateAll({ ...base, compress: false }).compress, false);
            assert.throws(() => validator.validateAll({ ...base, compress: 'yes' }), /compress/);
        })
    })

    describe('constants conformance', function () {
        const DOCS = process.env.XCHAIN_DOCUMENTATION_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-documentation')
        const DOCS_CONSTANTS = path.join(DOCS, 'protocol', 'constants.js')

        it('the local values are the pinned ones', function () {
            assert.strictEqual(validator.COMPRESSION_CODE_DEFLATE_RAW, '1')
            assert.strictEqual(validator.COMPRESSION_MAX_RATIO, 150)
            assert.strictEqual(validator.COMPRESSION_MAX_INPUT_BYTES, 16 * 1024 * 1024)
        })

        it('they equal the canonical declaration (skips without the docs sibling)', function () {
            if (!fs.existsSync(DOCS_CONSTANTS)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('xchain-documentation sibling not found but XCHAIN_REQUIRE_SIBLINGS=1')
                this.skip()
            }
            const docs = require(DOCS_CONSTANTS)
            assert.strictEqual(docs.COMPRESSION_CODE_DEFLATE_RAW, validator.COMPRESSION_CODE_DEFLATE_RAW)
            assert.strictEqual(docs.COMPRESSION_MAX_RATIO, validator.COMPRESSION_MAX_RATIO)
            assert.strictEqual(docs.COMPRESSION_MAX_INPUT_BYTES, validator.COMPRESSION_MAX_INPUT_BYTES)
        })

        // The encoder and the SDK each vendor this logic (independent
        // containers, no shared node_modules). They must agree on every
        // decision or a payload the SDK marked compressed could be emitted
        // raw, or vice versa.
        it('agrees with the SDK helper on every decision (skips without the sdk sibling)', async function () {
            const SDK = process.env.XCHAIN_SDK_DIR || path.join(__dirname, '..', '..', '..', 'xchain-sdk')
            const SDK_COMPRESSION = path.join(SDK, 'src', 'compression.js')
            if (!fs.existsSync(SDK_COMPRESSION)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('xchain-sdk sibling not found but XCHAIN_REQUIRE_SIBLINGS=1')
                this.skip()
            }
            const SdkCompression = require(SDK_COMPRESSION)
            const sdk = new SdkCompression()

            const payloads = [
                compressibleBytes(5000),
                crypto.randomBytes(5000),
                Buffer.alloc(200000, 0x20),
                Buffer.alloc(0)
            ]
            for (const payload of payloads) {
                const sdkResult = await sdk.compressIfSmaller(payload)
                const encoderResult = await compression.compressPayloadForAction(PUBLIC_FILE, payload)
                assert.strictEqual(encoderResult.compressed, sdkResult.compressed,
                    `keep/discard decision diverged for a ${payload.length}-byte payload`)
                if (sdkResult.compressed)
                    assert.ok(encoderResult.rawData.equals(sdkResult.bytes), 'compressed bytes diverged')
            }

            // And they agree on where the field lives.
            assert.strictEqual(SdkCompression.COMPRESSION_FIELD_INDEX, compression.COMPRESSION_FIELD_INDEX)
            assert.strictEqual(SdkCompression.GATE_TICKER_FIELD_INDEX, compression.GATE_TICKER_FIELD_INDEX)
            assert.strictEqual(sdk.withCompressionField(PUBLIC_FILE, '1'),
                compression.withCompressionField(PUBLIC_FILE, '1'))
        })
    })
})
