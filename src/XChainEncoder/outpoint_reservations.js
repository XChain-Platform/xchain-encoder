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

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { OperationalError } = require('../build/errors')
const { RESERVATION_TTL_MS } = require('./constants.js')

module.exports = {
    // Sweep the recent-build map the same way evictExpiredReservations sweeps
    // the outpoint map, so neither grows unbounded in a long-lived process.
    evictExpiredRecentBuilds(now) {
        for (const [txid, expiry] of this.recentBuilds) {
            if (expiry <= now) this.recentBuilds.delete(txid)
        }
    },

    // Refuse to hand back a transaction identical to one built within the
    // reservation window, then record this one. Identity is the UNSIGNED txid
    // (inputs, outputs, version, locktime): a rebuild that changes any of those
    // (an RBF bump, a different amount, a different input) is a different
    // transaction and passes. The outpoint reservations normally stop an
    // identical rebuild one layer earlier (every input is still reserved), so
    // this only fires when those were bypassed or cleared; it exists so the
    // "same txid twice" failure can never present as two successes again.
    refuseDuplicateBuild(psbt, now) {
        this.evictExpiredRecentBuilds(now)
        const unsignedTx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
        const txid = unsignedTx.getId()
        if (this.recentBuilds.has(txid)) {
            throw new OperationalError(
                'DUPLICATE_TRANSACTION',
                'refusing to rebuild a transaction identical to one built in the last ' +
                    Math.round(RESERVATION_TTL_MS / 60000) + ' minutes (same inputs and outputs, same txid ' +
                    txid + '); broadcast the one you already have, or change the inputs or outputs',
                { txid }
            )
        }
        this.recentBuilds.set(txid, now + RESERVATION_TTL_MS)
        // Returned so the caller can put the txid (and therefore this record) on
        // the build's reservation ticket: an explicit release has to retire the
        // duplicate refusal alongside the outpoints, or a wallet that composes,
        // releases and recomposes the SAME transaction is refused for the rest of
        // the window by the guard instead of the reservation map.
        return txid
    },

    // A reserved outpoint is one an in-flight selection has claimed and not yet
    // released. Expired entries are treated as free and lazily evicted here.
    isOutpointReserved(key, now) {
        const expiry = this.outpointReservations.get(key)
        if (expiry == null) return false
        if (expiry <= now) {
            this.outpointReservations.delete(key)
            return false
        }
        return true
    },

    // Returns the expiry it wrote, which doubles as this claim's ownership stamp
    // (see releaseCallReservations).
    reserveOutpoint(key, now) {
        const expiry = now + RESERVATION_TTL_MS
        this.outpointReservations.set(key, expiry)
        return expiry
    },

    // Reserve an outpoint AND record the claim on the calling createTransaction's
    // own ledger, so a later throw can hand it back.
    claimOutpoint(callReservations, key, now) {
        callReservations.push({ key, expiry: this.reserveOutpoint(key, now) })
    },

    // Release the reservations a single createTransaction call took, and only
    // those. The stored expiry is the ownership stamp: while a claim is live no
    // other call can take that outpoint (the selection loop skips reserved keys),
    // so the only way the map value can differ from what this call wrote is that
    // its claim already lapsed and somebody else re-reserved the outpoint against
    // a later clock. A mismatch therefore means the entry is foreign, and dropping
    // a foreign entry would reopen the same-address double-spend window the
    // reservation map exists to close. Leave it.
    releaseCallReservations(callReservations) {
        for (const claim of callReservations) {
            if (this.outpointReservations.get(claim.key) === claim.expiry){
                this.outpointReservations.delete(claim.key)
            }
        }
    },

    // The highest expiry any STILL-LIVE cancel owner holds on this outpoint, or
    // null when no live owner remains. This is the value outpointReservations must
    // carry while the cancel path holds an outpoint, and comparing it against the
    // reservation is how the build guard tells "held only by this path" from
    // "held by a foreign createTransaction claim".
    maxLiveCancelOwnerExpiry(key, now) {
        const owners = this.envelopeCancelClaims.get(key)
        if (!owners) return null
        let max = null
        for (const expiry of owners.values()) {
            if (expiry > now && (max === null || expiry > max)) max = expiry
        }
        return max
    },

    // Drop ONE cancel build's owner token and restate what the outpoint is now
    // worth. While another live owner remains, outpointReservations is rewritten
    // to that owner's expiry and the key stays reserved: this is the whole point
    // of the owner set, because the releasing build's stamp is then no longer the
    // map's value and every stamp-checked delete below leaves the entry alone.
    // Returns true when the outpoint is still held by some other cancel owner.
    dropCancelOwner(key, ownerId, now) {
        const owners = this.envelopeCancelClaims.get(key)
        if (!owners) return false
        owners.delete(ownerId)
        const remaining = this.maxLiveCancelOwnerExpiry(key, now)
        if (remaining === null) {
            this.envelopeCancelClaims.delete(key)
            return false
        }
        this.outpointReservations.set(key, remaining)
        return true
    },

    // Release an envelope-cancel claim and its ownership token together, so a
    // failed cancel build hands the commit outpoint back instead of squatting it
    // for the whole TTL - but only once no other cancel build still owns it. A
    // retry of a lost-response cancel legitimately re-claims an outpoint the first
    // build is still outstanding on, and deleting the reservation outright on the
    // retry's failure freed that outpoint to createTransaction while the earlier
    // unsigned cancel spent it. Ownership-checked exactly like
    // releaseCallReservations: a stamp that moved belongs to somebody else.
    releaseEnvelopeCancelClaims(callReservations) {
        const now = Date.now()
        const handBack = []
        for (const claim of callReservations) {
            // A claim another cancel owner still holds is withheld from the stamped
            // release below, and deliberately not left to that check: two builds a
            // millisecond apart share an expiry, so the stamp alone cannot tell the
            // surviving owner's reservation from this one's.
            if (claim.cancelOwnerId && this.dropCancelOwner(claim.key, claim.cancelOwnerId, now)) continue
            handBack.push(claim)
        }
        this.releaseCallReservations(handBack)
    },

    // Sweep the cancel ownership tokens alongside the reservation map, so neither
    // grows unbounded in a long-lived process. An outpoint whose last owner token
    // has lapsed goes with it.
    evictExpiredEnvelopeCancelClaims(now) {
        for (const [key, owners] of this.envelopeCancelClaims) {
            for (const [ownerId, expiry] of owners) {
                if (expiry <= now) owners.delete(ownerId)
            }
            if (owners.size === 0) this.envelopeCancelClaims.delete(key)
        }
    },

    // Sweep expired reservations so the map cannot grow unbounded across a
    // long-lived process. Called opportunistically at the start of selection.
    evictExpiredReservations(now) {
        for (const [key, expiry] of this.outpointReservations) {
            if (expiry <= now) this.outpointReservations.delete(key)
        }
    },

    // Sweep expired tickets so the ticket map cannot outgrow the reservation map
    // it describes. A ticket expires with the LAST of its claims.
    evictExpiredReservationTickets(now) {
        for (const [id, ticket] of this.reservationTickets) {
            if (ticket.expiry <= now) this.reservationTickets.delete(id)
        }
    },

    // Mint the receipt for the claims a SUCCESSFUL build kept, so the caller can
    // hand them back the moment it knows it will not broadcast (the wallet closes
    // its compose modal) instead of stranding a funded address for the rest of
    // RESERVATION_TTL_MS. Returns null when the build claimed nothing still live,
    // and the result then simply carries no reservation block: a release RPC that
    // has nothing to release must not mint a ticket that pretends otherwise.
    //
    // Only claims whose stamp is still the map's value go on the ticket. Anything
    // else already lapsed and was re-taken by another call, and putting it on this
    // ticket would hand this caller a lever over a foreign claim.
    mintReservationTicket(callReservations, now) {
        this.evictExpiredReservationTickets(now)
        const live = []
        for (const claim of callReservations) {
            // cancelOwnerId rides onto the ticket because releaseReservation has to
            // retire this build's owner token as well as its reservation; leaving it
            // behind would hold the outpoint until the token's own TTL lapsed.
            if (this.outpointReservations.get(claim.key) === claim.expiry) {
                live.push({ key: claim.key, expiry: claim.expiry, cancelOwnerId: claim.cancelOwnerId || null })
            }
        }
        if (live.length === 0) return null
        const id = crypto.randomBytes(16).toString('hex')
        let expiry = 0
        for (const claim of live) if (claim.expiry > expiry) expiry = claim.expiry
        const txid = callReservations.buildTxid || null
        this.reservationTickets.set(id, {
            claims: live,
            expiry,
            txid,
            // The recent-build record's own ownership stamp, read back rather than
            // recomputed so a rebuild that re-registered the txid under a later
            // clock is left alone by this ticket's release.
            txidExpiry: txid ? (this.recentBuilds.get(txid) || null) : null
        })
        return { id, outpoints: live.map(c => c.key), expiresAt: expiry }
    },

    // Explicit, ownership-stamped release of ONE build's reservations, the
    // counterpart of the receipt mintReservationTicket put on that build's
    // result. The wallet composes when its send modal opens and most of those
    // builds are never broadcast, so without this every abandoned compose held a
    // few-UTXO address's whole balance for five minutes and the next compose read
    // as insufficient funds. Idempotent and never an error: an unknown, already
    // released or lapsed ticket returns found:false rather than throwing, because
    // a wallet firing this from a modal-close handler cannot usefully react to a
    // failure and must not be taught to retry one.
    //
    // Ownership is enforced twice: the ticket id is 16 unguessable bytes handed
    // only to the build that took the claims, and each claim is dropped only while
    // the map still holds the exact expiry that build wrote. A claim whose stamp
    // moved lapsed and was re-taken by somebody else, so it is REPORTED (retained)
    // and left in place; dropping it would reopen the same-address double-spend
    // window the reservation map exists to close.
    releaseReservation(reservationId) {
        if (typeof reservationId !== 'string' || !/^[0-9a-f]{32}$/.test(reservationId)) {
            throw new TypeError('reservationId must be a 32-character lowercase hex string, as returned in create_tx result.reservation.id')
        }
        const now = Date.now()
        this.evictExpiredReservations(now)
        this.evictExpiredEnvelopeCancelClaims(now)
        this.evictExpiredRecentBuilds(now)
        this.evictExpiredReservationTickets(now)
        const ticket = this.reservationTickets.get(reservationId)
        if (!ticket) return { reservationId, found: false, released: [], retained: [] }
        // A ticket is single-use: the claims it names are either freed now or were
        // already taken over by another call, and either way it has no further use.
        this.reservationTickets.delete(reservationId)
        const released = []
        const retained = []
        for (const claim of ticket.claims) {
            // Retire this build's cancel owner token first, whatever the stamp says.
            // A ticket whose stamp has moved still has to give the token up, or the
            // outpoint would stay reserved at this build's expiry long after the
            // build that took it over released. dropCancelOwner restates the
            // reservation at the highest expiry a surviving owner holds, which is
            // also what makes the stamp check below leave that owner's entry alone.
            const stillHeldByAnotherCancel = claim.cancelOwnerId
                ? this.dropCancelOwner(claim.key, claim.cancelOwnerId, now)
                : false
            if (!stillHeldByAnotherCancel && this.outpointReservations.get(claim.key) === claim.expiry) {
                this.outpointReservations.delete(claim.key)
                released.push(claim.key)
            } else {
                retained.push(claim.key)
            }
        }
        // Retire the duplicate-build refusal for this build too, under the same
        // stamp check. Releasing the inputs without it just moves the five-minute
        // wall: the recompose that follows a release is byte-identical by
        // construction and would be refused DUPLICATE_TRANSACTION instead.
        if (ticket.txid && ticket.txidExpiry != null && this.recentBuilds.get(ticket.txid) === ticket.txidExpiry) {
            this.recentBuilds.delete(ticket.txid)
        }
        return { reservationId, found: true, released, retained }
    },

    // Explicit release of all reservations and recent-build records. The encoder
    // holds no durable state, so this is primarily a test seam; production
    // relies on the TTL.
    clearReservations() {
        this.outpointReservations.clear()
        this.recentBuilds.clear()
        this.envelopeCancelClaims.clear()
        this.reservationTickets.clear()
    },
}
