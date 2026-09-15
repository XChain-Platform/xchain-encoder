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

const { validateUtxoEntry } = require('../../common/validator')
const { OperationalError } = require('../../build/errors')
const { upstreamErrorMessage } = require('../../common/error_sanitize')
const { classifyTrackerFreshness, resolveCallerAddress } = require('../request_resolution.js')

function initInputState(build){
    let { replacebyfee, p2shHash } = build
    let psbt = null
    
    // 0xfffffffd, not 1. Any value below 0xfffffffe signals RBF (BIP125), but
    // bit 31 (0x80000000) is what DISABLES BIP68 relative locktime. nSequence=1
    // leaves that bit clear, so it also asserts "this input must be 1 block
    // old" - invisible when spending confirmed outputs, and fatal when spending
    // unconfirmed change, where the node rejects the transaction as
    // `non-BIP68-final`. That made RBF and chained sends mutually exclusive:
    // measured 2026-08-27 driving three chained MINTs. 0xfffffffd
    // signals RBF and keeps BIP68 off, which is what Bitcoin Core itself uses.
    let utxoSequence = (replacebyfee? 0xfffffffd: 0xffffffff)
    // BigInt: a DOGE UTXO set can total past 2^53-1 sats, where Number
    // arithmetic silently rounds the fee/change math.
    let inputSatoshis = 0n

    // The P2SH/P2WSH reveal (phase 2) spends phase-1's OWN funding outputs,
    // reconstructed from p2shHex further below; it never selects spendable
    // UTXOs. Re-querying the tracker on the reveal is not just wasted work:
    // the sender address is often already empty (phase 1 moved the funds on
    // chain), so tracker lag or that empty post-phase-1 view would strand a
    // mid-flow reveal. Derive inputs from the phase-1 context we were handed
    // and skip the tracker entirely; fall back to it only if the phase-1 hex
    // is somehow missing (an invalid reveal call).
    const isReveal = !!p2shHash
    let fetchedFromTracker = false
    Object.assign(build, { psbt, utxoSequence, inputSatoshis, isReveal, fetchedFromTracker })
}

function checkExactInputs(build){
    let { options, isReveal, utxos } = build
    // Exact-input mode. Normal selection sorts the candidate set
    // value-descending and stops the moment the running total covers outputs
    // plus fee, so a caller who names N outpoints usually gets one input. That
    // makes an operator rescue of a stuck batch impossible to build here: a CPFP
    // child has to descend from EVERY unconfirmed output of the stuck chain
    // (including the tiny ones greedy selection will never reach), and a
    // deliberate chain has to spend a named change output rather than whichever
    // output happens to be largest. Exact-input mode turns selection off: the
    // caller's list IS the input set, in the caller's order, all of it.
    //
    // It is coin-control, so it is only meaningful over a caller-supplied set.
    // Refuse it rather than silently degrade when there is nothing to be exact
    // about, and on the reveal path, whose inputs come from p2shHex and never
    // pass through selection at all.
    const exactInputs = !!(options && options.exactInputs)
    if (exactInputs){
        if (isReveal){
            throw new TypeError(
                'options.exactInputs cannot be combined with p2shHash: the reveal spends the ' +
                'funding transaction\'s own outputs, which are derived from p2shHex, not selected')
        }
        if ((utxos == null) || (utxos.length == 0)){
            throw new TypeError(
                'options.exactInputs requires a non-empty utxos array: it names the exact input ' +
                'set to spend, so there is nothing to be exact about when the set is fetched')
        }
    }
    Object.assign(build, { exactInputs })
}

// The candidate set: the caller's utxos, an empty set on a reveal, or the
// tracker's view of the caller's address.
async function gatherUtxos(build){
    let { utxos, isReveal, p2shHex } = build
    if ((utxos == null) || (utxos.length == 0)){
        if (isReveal && p2shHex){
            utxos = []
        Object.assign(build, { utxos })
        } else {
        await fetchTrackerUtxos.call(this, build)
        }
    }
}

async function fetchTrackerUtxos(build){
    let { pubkey } = build
    let fetched
    try {
        fetched = await this.utxoTrackerConnector.getUtxosFromAddress(resolveCallerAddress(pubkey, this.network))
    } catch (err) {
        // Surface a typed, credential-free operational error. A
        // transport failure embeds the tracker's internal host:port,
        // so upstreamErrorMessage collapses it to the generic
        // fallback; the tracker's own application messages (lag,
        // address-too-large) are safe and actionable and pass through.
        throw new OperationalError('UTXO_TRACKER_ERROR', upstreamErrorMessage(err, 'UTXO tracker unavailable'))
    }

    // Freshness gate. get_utxos carries an additive
    // `sync` sibling field ({tracker_height, node_height, lag, synced,
    // mempool_ready, halted?, halt_reason?}) on trackers that have picked up
    // the ce16bdd freshness surface. Refuse to select from a view the tracker
    // itself flags NOT synced or NOT mempool-ready, one it has halted on, or
    // one whose lag is outside our own (tighter) bounds, before any input is
    // chosen.
    // `sync` is absent on an older tracker: fail OPEN (old behavior) rather
    // than block every create_tx, since this ships ahead of every tracker
    // in the fleet being upgraded.
    // One classifier, shared with api.js getServeReadiness(); the ordering,
    // the strict-equality fail-open rules and the operator text all live in
    // classifyTrackerFreshness above.
    const freshness = classifyTrackerFreshness(fetched && fetched.sync, this.maxUtxoTrackerLagBlocks)
    if (freshness.code){
        throw new OperationalError(freshness.code, freshness.message, freshness.details)
    }

    acceptTrackerUtxos(build, fetched)
}

function acceptTrackerUtxos(build, fetched){
    let { utxos, fetchedFromTracker } = build
    utxos = fetched["utxos"]

    // The tracker's utxos field must be an array. Anything else with a
    // length (a string, most plausibly an error body that got read as the
    // payload) walks straight past the emptiness check below and is then
    // indexed element by element, so a malformed tracker response surfaced
    // as "utxos[0] must be an object" and pointed the operator at a UTXO
    // that does not exist instead of at the response shape.
    if ((utxos != null) && !Array.isArray(utxos)){
        throw new OperationalError(
            'UTXO_TRACKER_ERROR',
            `utxo-tracker returned a utxos field that is not an array (got ${typeof utxos})`
        )
    }

    if ((utxos == null) || (utxos.length == 0)){
        throw new OperationalError('NO_UTXOS', "no utxos were provided and no utxos found on the blockchain")
    }
    fetchedFromTracker = true

    //Tracker-fetched UTXOs bypass the caller-API validation path, yet
    //feed into the same PSBT construction code below. Run each through
    //the same per-entry checks (64-char hex txid, integer vout/value,
    //non-empty scriptPubKey hex, confirmations defaulted) so a
    //malformed tracker output is rejected here instead of throwing
    //deep inside bitcoinjs-lib's psbt.addInput(). Deliberately
    //per-entry, NOT validateUtxoArray: the latter also enforces the
    //caller-facing MAX_UTXO_COUNT cap, which must NOT gate an
    //internally-fetched set (an address holding more than that many
    //UTXOs would otherwise be unable to build any transaction). The
    //SELECTED input count is bounded after selection instead.
    for (let vi = 0; vi < utxos.length; vi++){
        validateUtxoEntry(utxos[vi], vi)
    }
    Object.assign(build, { utxos, fetchedFromTracker })
}

function refuseShrunkExactInputs(build){
    let { exactInputs, unconfirmed, utxos } = build
    // Exact-input mode promises the caller's list is the input set, so the two
    // filters below (which silently SHRINK that list) have to be errors instead.
    // Dropping a named mempool outpoint is the CPFP-fatal one: the whole point of
    // the rescue is descending from unconfirmed outputs, and a silent drop would
    // hand back a child that descends from nothing and still does not mine.
    if (exactInputs){
        if (!unconfirmed){
            const mempoolInput = utxos.find((u) => u.confirmations == 0)
            if (mempoolInput){
                throw new TypeError(
                    `options.exactInputs names unconfirmed utxo ${mempoolInput.txid}:${mempoolInput.vout}, ` +
                    'but unconfirmed=false would drop it; pass unconfirmed: true to spend it')
            }
        }
        const seenOutpoints = new Set()
        for (const u of utxos){
            const k = u.txid + ':' + u.vout
            if (seenOutpoints.has(k)){
                throw new TypeError(
                    `options.exactInputs names outpoint ${k} more than once; a transaction cannot spend the same output twice`)
            }
            seenOutpoints.add(k)
        }
    }
}

// Dedup, mempool filter and value-descending order, all in place on `utxos`.
function filterAndOrderUtxos(build){
    let { utxos, unconfirmed, isReveal, exactInputs } = build
    // Remove duplicated utxos (the utxo tracker returns duplicated utxos sometimes)
    // and, when unconfirmed is false, every mempool entry along with them.
    //
    // Single linear pass with an outpoint Set, compacting in place. It replaces a
    // nested while whose inner loop re-scanned the tail for every surviving entry
    // and called Array.splice on each hit: O(n^2) comparisons plus an O(n) element
    // shift per removal, so a duplicate-heavy set was cubic-ish in the worst case.
    // The caller-supplied path is capped at MAX_UTXO_COUNT (500), but the
    // tracker-fetched path deliberately is NOT (see the per-entry validation note
    // above), so a hot address with tens of thousands of outputs spent the build
    // inside this loop.
    //
    // Semantics preserved exactly: first occurrence of an outpoint wins, relative
    // order of survivors is unchanged, the mempool filter is applied BEFORE dedup
    // (so an unconfirmed duplicate cannot claim the slot of a confirmed one when
    // unconfirmed=false), and the array is mutated IN PLACE because downstream code
    // and the caller both hold this same reference.
    const seenUtxoOutpoints = new Set()
    let utxoWriteIndex = 0
    for (let utxoReadIndex = 0; utxoReadIndex < utxos.length; utxoReadIndex++){
        const nextUtxo = utxos[utxoReadIndex]
        // if the tx is in the mempool, drop it if unconfirmed is false
        if (!unconfirmed && (nextUtxo.confirmations == 0)) continue
        // Loose-equality txid/vout matching became string-key matching: both sides
        // are concatenated through the same String() coercion, so a numeric 0 and a
        // string '0' vout still collide exactly as `==` made them collide.
        const outpointKey = nextUtxo.txid + ':' + nextUtxo.vout
        if (seenUtxoOutpoints.has(outpointKey)) continue
        seenUtxoOutpoints.add(outpointKey)
        utxos[utxoWriteIndex++] = nextUtxo
    }
    utxos.length = utxoWriteIndex

    //If unconfirmed=false stripped every mempool UTXO and nothing
    //confirmed remains, surface the same error as a never-funded
    //address rather than crashing on utxos[0] below. The reveal path
    //legitimately has an empty utxos array here (its inputs come from
    //p2shHex), so only the funding/single-tx path treats empty as fatal.
    if (utxos.length == 0 && !isReveal){
        throw new OperationalError('NO_UTXOS', "no utxos were provided and no utxos found on the blockchain")
    }

    // Comparator, not subtraction: a >2^53-1 value is a BigInt here, and
    // BigInt - Number throws. Relational operators mix the two types fine.
    // Exact-input mode keeps the caller's order untouched: every named outpoint
    // is spent either way, so the only thing sorting would change is WHICH one
    // lands at ins[0] - and on the OP_RETURN/MULTISIGN path that outpoint is the
    // obfuscation key, which coin-control callers pick deliberately.
    if (!exactInputs){
        utxos.sort((a,b)=> a.value < b.value ? 1 : a.value > b.value ? -1 : 0)
    }
}

module.exports = { initInputState, checkExactInputs, gatherUtxos, refuseShrunkExactInputs, filterAndOrderUtxos }
