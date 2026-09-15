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
 *
 * XChain Encoder - Encoder Class
 * 
 * This file handles starting the encoder and generating transactions
 * 
 ********************************************************************/

const { OperationalError } = require('../../build/errors')
const { RESERVATION_TTL_MS } = require('../constants.js')

function bindObfuscationKey(build){
    let { utxos, exactInputs, callReservations } = build
    //On the reveal path utxos is empty; txidFirstInput is (re)assigned from
    //p2shHex inside the data loop below before it is ever read.
    //
    // The OP_RETURN/MULTISIGN obfuscation key MUST bind to the txid of the input actually
    // placed at ins[0]: the decoder derives its deobfuscation key from transaction.ins[0].
    // The selection loop below skips outpoints a concurrent/recent create_tx reserved
    // (caller-supplied sets included), so sorted utxos[0] is NOT necessarily the first input.
    // Synchronously pre-reserve the first AVAILABLE outpoint now - before the async data
    // loop, so no concurrent call can claim it in between - and bind the key to it; the
    // selection loop carves this outpoint out of its skip check so it is taken as ins[0].
    // Without this, a reservation skip bound the key to utxos[0] while ins[0] was utxos[1],
    // the decoder failed the magic-word check, and the action silently never happened (valid
    // tx, inputs spent, fee burned).
    //
    // The carve-out alone is NOT enough. It guarantees the pre-reserved
    // outpoint is SELECTED, not that it is FIRST: the selection loop re-evaluates
    // reservations against a LATER clock, and isOutpointReserved treats expiry <= now as
    // free, so a foreign reservation blocking an EARLIER-sorted outpoint that lapses during
    // the async data loop un-skips that outpoint and it takes ins[0] while the key stays
    // bound here. Move the key-bound outpoint to the head of the selection order so ins[0]
    // is correct by construction, independent of any clock.
    //
    // Reservation is NOT gated on fetchedFromTracker. The SDK fetches the funding
    // set through get_utxos and passes it as `utxos`, so a caller-supplied set is
    // the wallet's normal path; leaving it unreserved is exactly the hole that let
    // two chained sends 800ms apart build the same transaction.
    //
    // Exact-input mode is the one shape that cannot SKIP a reserved outpoint: it
    // promises every named outpoint is spent (a CPFP rescue descends from all of
    // them), so dropping one would hand back a child that descends from nothing,
    // the same silent shrink the unconfirmed/duplicate filters above were turned
    // into errors to prevent. It still reserves - a named set is exactly the
    // chained-send shape this guards against - but it refuses the build outright
    // when another build holds one of the named outpoints, and it never reorders
    // (the caller picked which outpoint lands at ins[0] and owns that key).
    let firstReservedOutpoint = null
    let txidFirstInput = null
    if (utxos.length){
        if (exactInputs){
            txidFirstInput = claimExactInputs.call(this, callReservations, utxos, txidFirstInput)
        } else {
            ({ firstReservedOutpoint, txidFirstInput } = claimFirstFreeInput.call(this, callReservations, utxos, firstReservedOutpoint, txidFirstInput))
        }
        // Lowercase where the key BINDS, not only at validation: this string is the
        // obfuscation key itself, the decoder's half of it always renders lowercase,
        // and the ins[0] guard below compares against a lowercase hex rendering of the
        // PSBT input. validateUtxoEntry canonicalizes both ingest paths, but a caller
        // using the encoder as a library reaches createTransaction without it, and a
        // mixed-case txid must not turn into a permanent failure wearing a retryable
        // INPUT_SELECTION_RACE label.
        if (txidFirstInput != null) txidFirstInput = String(txidFirstInput).toLowerCase()
    }
    Object.assign(build, { firstReservedOutpoint, txidFirstInput })
}

// Exact-input mode: claim every named outpoint or refuse the build.
function claimExactInputs(callReservations, utxos, txidFirstInput){
    const nowFirst = Date.now()
    this.evictExpiredReservations(nowFirst)
    const heldByOthers = utxos
        .map((u) => u.txid + ':' + u.vout)
        .filter((k) => this.isOutpointReserved(k, nowFirst))
    if (heldByOthers.length){
        throw new OperationalError(
            'INPUT_RESERVED',
            `options.exactInputs names ${heldByOthers.length} outpoint(s) reserved by a transaction ` +
                `built in the last ${Math.round(RESERVATION_TTL_MS / 60000)} minutes ` +
                `(${heldByOthers.join(', ')}); exact-input mode cannot drop them, so broadcast that ` +
                'transaction and rebuild from the resulting view, or wait for the reservation to lapse',
            { reserved: heldByOthers }
        )
    }
    for (const u of utxos){
        this.claimOutpoint(callReservations, u.txid + ':' + u.vout, nowFirst)
    }
    // No head-of-order splice: the caller's order IS the input order here,
    // and firstReservedOutpoint stays null so the selection loop below
    // reserves nothing twice (every outpoint is already claimed).
    txidFirstInput = utxos[0]["txid"]
    return txidFirstInput
}

// Greedy mode: claim the first outpoint no other build holds and move it to ins[0].
function claimFirstFreeInput(callReservations, utxos, firstReservedOutpoint, txidFirstInput){
    const nowFirst = Date.now()
    this.evictExpiredReservations(nowFirst)
    for (let i = 0; i < utxos.length; i++){
        const u = utxos[i]
        const k = u.txid + ':' + u.vout
        if (!this.isOutpointReserved(k, nowFirst)){
            this.claimOutpoint(callReservations, k, nowFirst)
            firstReservedOutpoint = k
            txidFirstInput = u.txid
            // Head-of-order splice. The skipped entries ahead of it were all
            // reserved at nowFirst, so this only reorders against outpoints this
            // call was never allowed to take anyway; if one of them frees before
            // selection it is still selected, just after ins[0]. Value-descending
            // order among the remaining entries is preserved.
            if (i > 0) utxos.unshift(utxos.splice(i, 1)[0])
            break
        }
    }
    // Every fetched outpoint already reserved: nothing could be pre-reserved, so the
    // ins[0] invariant cannot be established by construction here. Fall back to
    // utxos[0] for a deterministic key. Usually the selection loop then selects
    // nothing and the build surfaces the shortfall, but its own eviction pass can
    // free a DIFFERENT outpoint first; the post-selection guard below catches that
    // and fails closed rather than emitting a silently-undecodable action.
    if (txidFirstInput === null) txidFirstInput = utxos[0]["txid"]
    return { firstReservedOutpoint, txidFirstInput }
}

module.exports = { bindObfuscationKey }
