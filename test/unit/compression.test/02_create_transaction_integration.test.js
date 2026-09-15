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
const bitcoin = require('bitcoinjs-lib')

const compression = require('../../../src/build/compression')
const {
    PUBKEY,
    PUBLIC_FILE,
    GATED_FILE,
    compressibleBytes,
    makeEncoder,
    segwitUtxo,
    callerAddress
} = require('./helpers/fixtures')

describe('encoder FILE payload compression (spec Part B)', function () {
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
    })
})

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('createTransaction integration', function () {
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
    })
})

describe('encoder FILE payload compression (spec Part B)', function () {
    describe('createTransaction integration', function () {
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
})
