'use strict';

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
 * (a): the outpoint dedup / mempool filter in _buildTransaction.
 *
 * It was a nested while whose inner loop re-scanned the tail for every
 * surviving entry and called Array.splice on each hit: quadratic comparisons
 * plus an O(n) element shift per removal. The caller path is capped at
 * MAX_UTXO_COUNT, but the tracker-fetched path is deliberately uncapped, so a
 * hot address spent the whole build inside that loop.
 *
 * The semantics tests below pin what must not change; the last one pins that it
 * is no longer quadratic, and is the test that goes red if the old loop returns.
 *
 ********************************************************************/

const assert = require('assert')
const {
    TXID_A,
    TXID_B,
    TXID_C,
    makeUtxo,
    makeMempoolUtxo,
    makeEncoder,
    getTestAddress
} = require('../../integration/helpers/utxoFactory')

const NETWORK = 'bitcoin-regtest'

// The dedup filters the caller's array IN PLACE, so the array a test hands in is
// the observation surface. A fresh encoder holds no reservations, so the
// head-of-order splice further down never fires and the surviving order is the
// dedup's own output.
function build(encoder, address, utxos, unconfirmed) {
    return encoder.createTransaction(
        utxos, address, null, 'test', null, 10000, false, null, address,
        null, null, null, unconfirmed, 0.00001
    )
}

function outpoints(utxos) {
    return utxos.map((u) => u.txid + ':' + u.vout)
}

function makeCountedUtxos(count, counter) {
    const utxos = []
    for (let i = 0; i < count; i++) {
        const txid = i.toString(16).padStart(64, '0')
        const utxo = makeUtxo(NETWORK, txid, 0, 1000)
        Object.defineProperty(utxo, 'txid', {
            enumerable: true,
            get() {
                counter.reads++
                return txid
            }
        })
        utxos.push(utxo)
    }
    return utxos
}

describe('_buildTransaction outpoint dedup / mempool filter', function () {

    it('keeps the FIRST occurrence of a repeated outpoint and drops the rest', async function () {
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const first = makeUtxo(NETWORK, TXID_A, 0, 100000000)
        const dup = makeUtxo(NETWORK, TXID_A, 0, 100000000)
        const utxos = [first, dup, makeUtxo(NETWORK, TXID_B, 0, 100000000)]

        const result = await build(encoder, address, utxos, true)
        assert.ok(result.psbt)
        assert.deepStrictEqual(outpoints(utxos), [TXID_A + ':0', TXID_B + ':0'])
        assert.strictEqual(utxos[0], first, 'the FIRST occurrence must be the survivor, not the last')
    })

    it('preserves the relative order of the survivors', async function () {
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        // Interleaved duplicates: an implementation that compacts by swapping with
        // the tail instead of shifting would reorder these.
        const utxos = [
            makeUtxo(NETWORK, TXID_A, 0, 100000000),
            makeUtxo(NETWORK, TXID_B, 0, 100000000),
            makeUtxo(NETWORK, TXID_A, 0, 100000000),
            makeUtxo(NETWORK, TXID_C, 0, 100000000),
            makeUtxo(NETWORK, TXID_B, 0, 100000000),
            makeUtxo(NETWORK, TXID_C, 1, 100000000)
        ]

        await build(encoder, address, utxos, true)
        assert.deepStrictEqual(outpoints(utxos),
            [TXID_A + ':0', TXID_B + ':0', TXID_C + ':0', TXID_C + ':1'])
    })

    it('distinguishes two vouts of the same txid', async function () {
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const utxos = [
            makeUtxo(NETWORK, TXID_A, 0, 100000000),
            makeUtxo(NETWORK, TXID_A, 1, 100000000),
            makeUtxo(NETWORK, TXID_A, 2, 100000000)
        ]

        await build(encoder, address, utxos, true)
        assert.strictEqual(utxos.length, 3, 'same txid, different vout, is not a duplicate')
    })
})

describe('_buildTransaction outpoint dedup / mempool filter', function () {
    it('drops every mempool entry when unconfirmed is false', async function () {
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const utxos = [
            makeMempoolUtxo(TXID_A, 0, 100000000),
            makeUtxo(NETWORK, TXID_B, 0, 100000000),
            makeMempoolUtxo(TXID_C, 0, 100000000)
        ]

        await build(encoder, address, utxos, false)
        assert.deepStrictEqual(outpoints(utxos), [TXID_B + ':0'])
    })

    it('keeps mempool entries when unconfirmed is true', async function () {
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const utxos = [
            makeMempoolUtxo(TXID_A, 0, 100000000),
            makeUtxo(NETWORK, TXID_B, 0, 100000000)
        ]

        await build(encoder, address, utxos, true)
        assert.deepStrictEqual(outpoints(utxos), [TXID_A + ':0', TXID_B + ':0'])
    })
})

describe('_buildTransaction outpoint dedup / mempool filter', function () {
    it('applies the mempool filter BEFORE dedup, so a confirmed twin survives', async function () {
        // The ordering is load-bearing. Dedup-first would let the unconfirmed entry
        // claim the outpoint's slot and then the mempool filter would delete it,
        // silently losing a confirmed, spendable output.
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const confirmed = makeUtxo(NETWORK, TXID_A, 0, 100000000)
        const utxos = [makeMempoolUtxo(TXID_A, 0, 100000000), confirmed]

        await build(encoder, address, utxos, false)
        assert.deepStrictEqual(outpoints(utxos), [TXID_A + ':0'])
        assert.strictEqual(utxos[0], confirmed, 'the confirmed twin must be what survives')
        assert.strictEqual(utxos[0].confirmations, 6)
    })

    it('collapses a set that is nothing but copies of one outpoint', async function () {
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const utxos = []
        for (let i = 0; i < 5000; i++) utxos.push(makeUtxo(NETWORK, TXID_A, 0, 100000000))

        const result = await build(encoder, address, utxos, true)
        assert.ok(result.psbt)
        assert.strictEqual(utxos.length, 1, '5000 copies of one outpoint collapse to one')
    })

    // An address holding many DISTINCT outputs: the old inner while re-read every
    // later txid for every survivor (n^2/2 reads). Counting reads avoids wall-time flake.
    it('filters a large set of DISTINCT outpoints in linear time', async function () {
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const count = 2000
        const counter = { reads: 0 }
        const utxos = makeCountedUtxos(count, counter)

        const result = await build(encoder, address, utxos, true)

        assert.ok(result.psbt)
        assert.strictEqual(utxos.length, count, 'distinct outpoints are not duplicates')
        assert.ok(counter.reads >= count, 'the test must observe every candidate during filtering')
        assert.ok(counter.reads < count * 20,
            `filtering ${count} distinct outpoints read txid ${counter.reads} times; the quadratic scan is back`)
    })
})
