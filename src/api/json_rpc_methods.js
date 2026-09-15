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
 * XChain Encoder - JSON-RPC methods
 *
 * The serve-readiness probe and every JSON-RPC method the API dispatches,
 * built by a factory over the encoder instance and network the entry owns.
 *
 ********************************************************************/

const util = require('util')
const XChainEncoder  = require('../XChainEncoder');
const validator = require('../common/validator')
const { upstreamErrorMessage } = require('../common/error_sanitize')
const { getLogger } = require('../observability');
const { version: ENCODER_VERSION } = require('../../package.json')
const { readMaintenanceWindow } = require('../server/maintenance_window')   // operator-declared scheduled outage, reported beside readiness
const logger = getLogger();

// Each builder closes one group of methods over the encoder (and, for fees,
// the network name); the factory composes the groups into one controller. The
// method text keeps its entry indentation so the openrpc guard still matches.

// Serve-readiness probe shared by the JSON-RPC health() method and GET
// /status, so the two endpoints can never drift apart: probes the
// UTXO tracker and returns its reachability / sync state. Fields:
// tracker_reachable (bool), tracker_synced (bool), tracker_lag (number|null),
// tracker_halted (bool), tracker_mempool_ready (bool), maintenance (object|null).
//
// maintenance is the operator's DECLARED scheduled-outage window (see
// src/server/maintenance_window.js), carried alongside the readiness fields and never
// folded into them: it cannot make an unready encoder read ready, and it does
// not move the 503. A planned tracker stop and a broken tracker are the same
// readiness verdict - the difference is only that somebody meant one of them,
// which is exactly the distinction the public board had no way to draw.
//
// tracker_synced is SERVE-readiness, not the tracker's raw verdict: it
// applies the same maxUtxoTrackerLagBlocks ceiling create_tx enforces
// (deliberately tighter than the tracker's own SYNCED_THRESHOLD, money
// safety). Without the extra gate a 3-block lag read synced:true here while
// create_tx refused UTXO_TRACKER_STALE, so the status board painted Online
// on an un-serveable encoder. Null lag fails open, exactly like
// create_tx's overLag gate.
//
// A halted tracker (stopped polling on an unrecoverable reorg) and a negative
// lag (its committed tip sits above the node's, so its outputs are orphaned)
// are both un-serveable regardless of what `synced` says, and both were painting
// Online here because only the upper lag bound was checked. A tracker whose
// mempool has not reconverged is un-serveable for the same reason: create_tx
// refuses it UTXO_TRACKER_NOT_READY, so leaving it out of this probe recreated
// the same board-versus-encoder divergence the probe exists to prevent.
function buildReadinessMethods({ encoder }) {
async function getServeReadiness() {
    // Read first and independently of the tracker probe: the window is what
    // explains a tracker that is deliberately down, so it must survive the
    // catch below rather than depend on the probe it annotates.
    const maintenance = await readMaintenanceWindow()
    let tracker_reachable = false
    let tracker_synced = false
    let tracker_lag = null
    let tracker_halted = false
    let tracker_mempool_ready = false
    try {
        const status = await encoder.utxoTrackerConnector.getSyncStatus()
        tracker_reachable = true
        // This probe applies the SAME freshness classifier create_tx refuses a
        // tracker with, against this endpoint's payload, so the board and the
        // encoder cannot drift apart: both read getSyncStatus() through
        // classifyTrackerFreshness instead of each re-deriving over-lag,
        // behind-node, halted and mempool-ready. The remaining asymmetry is
        // intentional: readiness needs the tracker's POSITIVE synced assertion
        // (syncedClaimed), while the create_tx gate refuses only on negatives.
        const freshness = XChainEncoder.classifyTrackerFreshness(status, encoder.maxUtxoTrackerLagBlocks)
        tracker_halted = freshness.halted
        tracker_mempool_ready = freshness.mempoolReady
        tracker_synced = freshness.syncedClaimed && freshness.code === null
        tracker_lag = freshness.lag
    } catch (_err) {
        // tracker unreachable; fields stay at defaults
    }
    return { tracker_reachable, tracker_synced, tracker_lag, tracker_halted, tracker_mempool_ready, maintenance }
}

return {
    async ping() {
        return {status:"success", version: ENCODER_VERSION};
    },
    // Probes hard dependencies (UTXO tracker) and returns their reachability /
    // sync state. Unlike ping, a health failure means the encoder cannot serve
    // requests correctly. See getServeReadiness() for the readiness gate,
    // shared with GET /status below.
    async health() {
        return getServeReadiness()
    },
}
}

// Fee quoting needs the network name for the test-chain ceiling.
function buildFeeMethods({ encoder, NETWORK }) {
return {
    // Suggested fee tiers (base-unit per vByte: sat/koinu/litoshi) from the node's
    // estimatesmartfee at decreasing confirmation targets: low=slow/cheap (6
    // blocks) … high=next block (1). getFeePerKilobyte returns coin/kB; *1e5
    // converts to base-unit/byte (1e8 base-units per coin ÷ 1000 bytes per kB).
    // Floored at 1 so a tier is never 0. Read-only; no params.
    async estimate_fee() {
        const targets = { low: 6, medium: 3, high: 1 };
        const out = {};
        // Same test-chain ceiling createTx applies to a caller who supplies no
        // rate, so the quote matches what the build would actually charge.
        const capPerByte = XChainEncoder.suggestedFeeCeilingPerByte(NETWORK, 100000000);
        const capPerVbyte = capPerByte == null ? null : Math.max(1, Math.round(capPerByte * 100000000));
        try {
            for (const tier of Object.keys(targets)) {
                const feerate = await encoder.connector.getFeePerKilobyte(targets[tier]); // coin/kB
                let perVbyte = Math.max(1, Math.round(Number(feerate) * 100000));         // -> base-unit/byte
                if (capPerVbyte != null && perVbyte > capPerVbyte) perVbyte = capPerVbyte;
                out[tier] = perVbyte;
            }
        } catch (err) {
            logger.error(util.format('Fee estimation error:', err))
            const e = new Error('Fee estimation failed')
            e.code = -32603
            throw e
        }
        return out;
    },
}
}

// The build itself; every error class it can raise maps to one JSON-RPC code.
function buildTransactionMethods({ encoder }) {
return {
    async create_tx(rawParams) {
        let params
        try {
            params = validator.validateAll(rawParams)
        } catch (err) {
            const e = new Error(err.message)
            e.code = -32602
            throw e
        }

        let psbt
        try {
            psbt = await encoder.createTransaction(
                params.utxos, params.pubkey, params.customOutputs,
                params.data, params.rawData, params.fee, params.rbf,
                params.encoding, params.change, params.p2shHash, params.p2shHex,
                params.compressedPubKey, params.unconfirmed, params.feePerKb, params.dust,
                params.feeQuote, params.attachPrevTx, params.compress, params.options)
        } catch (err) {
            // Typed operational errors (no UTXOs, insufficient funds, missing
            // change address, tracker unavailable) are expected, caller-actionable
            // conditions with an encoder-authored, credential-free message and a
            // stable machine-readable code. Forward those so the wallet/SDK can
            // branch on them: message passes through and `xchainCode` (plus any
            // details payload) rides in the JSON-RPC error `data.reason`.
            if (err && err.operational === true) {
                const e = new Error(err.message)
                e.code = -32010
                e.data = Object.assign({ reason: err.xchainCode }, err.details || {})
                throw e
            }
            // Validation errors (TypeError/RangeError) carry safe messages from
            // our own validation. Everything else is an unexpected internal and is
            // collapsed to a generic message to prevent leaking internals
            // (host:port, stack, RPC credentials).
            const isKnown = err instanceof TypeError || err instanceof RangeError
            if (!isKnown) {
                logger.error(util.format('Encoder error:', err))
            }
            const e = new Error(isKnown ? err.message : 'Internal encoder error')
            e.code = -32603
            throw e
        }

        psbt["psbt"] = psbt["psbt"].toHex()
        // TAPROOT envelope: one call returns the {commit, reveal}
        // pair; the caller signs both and broadcasts commit then reveal.
        if (psbt["revealPsbt"]) {
            psbt["revealPsbt"] = psbt["revealPsbt"].toHex()
        }
        return psbt;
    },
}
}


function buildCancelMethods({ encoder }) {
return {
    // Key-path cancel of an unrevealed TAPROOT envelope commit: rebuilds the
    // sweep PSBT from the wallet's persisted recovery
    // record alone. Validation lives in the encoder method (typed
    // TypeError/RangeError -> -32602, OperationalError -> -32010).
    async create_envelope_cancel_tx(rawParams) {
        // Array.isArray for the same reason validator.validateAll carries it:
        // positional params otherwise clear the gate and destructure to undefined.
        if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
            const e = new Error('Request params must be an object')
            e.code = -32602
            throw e
        }
        let result
        try {
            result = await encoder.createEnvelopeCancelTransaction(rawParams)
        } catch (err) {
            if (err && err.operational === true) {
                const e = new Error(err.message)
                e.code = -32010
                e.data = Object.assign({ reason: err.xchainCode }, err.details || {})
                throw e
            }
            const isKnown = err instanceof TypeError || err instanceof RangeError
            if (!isKnown) {
                logger.error(util.format('Encoder error:', err))
            }
            const e = new Error(isKnown ? err.message : 'Internal encoder error')
            e.code = isKnown ? -32602 : -32603
            throw e
        }
        result.psbt = result.psbt.toHex()
        return result
    },
}
}


function buildReleaseMethods({ encoder }) {
return {
    // Hand back the input reservations ONE earlier build took, named by the
    // ticket id that build's result carried. The wallet composes when its send
    // modal opens and abandons most of those builds, and each abandoned one held
    // the address's inputs for the full reservation window, so the next compose
    // on a few-UTXO address reported insufficient funds against its own money.
    // Ownership lives in the ticket (unguessable id plus a per-claim stamp
    // re-checked at release time), so this method can never free another
    // caller's inputs; see XChainEncoder.releaseReservation.
    //
    // Deliberately never an error for an unknown, expired or already-released
    // ticket: a modal-close handler cannot act on a failure, and reporting one
    // would push clients to retry a call that has nothing left to do. found
    // tells them which it was.
    async release_inputs(rawParams) {
        let reservationId
        try {
            if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
                throw new TypeError('Request params must be an object')
            }
            reservationId = validator.validateReservationId(rawParams.reservationId)
        } catch (err) {
            const e = new Error(err.message)
            e.code = -32602
            throw e
        }
        try {
            return encoder.releaseReservation(reservationId)
        } catch (err) {
            const isKnown = err instanceof TypeError || err instanceof RangeError
            if (!isKnown) {
                logger.error(util.format('Encoder error:', err))
            }
            const e = new Error(isKnown ? err.message : 'Internal encoder error')
            e.code = isKnown ? -32602 : -32603
            throw e
        }
    },
}
}

// Node-facing broadcast; upstream error text is sanitized before it leaves.
function buildBroadcastMethods({ encoder }) {
return {
    async broadcast_tx(rawParams) {
        let tx_hex = rawParams && rawParams.tx_hex
        if (!tx_hex) {
            const e = new Error('Missing required parameter: tx_hex')
            e.code = -32602
            throw e
        }
        // Shed malformed/oversized payloads before the node round-trip; the
        // node would reject them anyway, this just answers with a precise
        // invalid-params reason instead of a node-side parse error.
        try {
            validator.validateRawTxHex(tx_hex)
        } catch (err) {
            const e = new Error(err.message)
            e.code = -32602
            throw e
        }

        try {
            let txid = await encoder.connector.sendRawTransaction(tx_hex)
            return { txid: txid }
        } catch (err) {
            logger.error(util.format('Broadcast error:', err))
            const e = new Error(upstreamErrorMessage(err, 'Transaction broadcast failed'))
            e.code = -32603
            throw e
        }
    },
}
}

// Tracker-facing UTXO lookup; upstream error text is sanitized before it leaves.
function buildUtxoMethods({ encoder }) {
return {
    async get_utxos(rawParams) {
        let address = rawParams && rawParams.address
        if (!address) {
            const e = new Error('Missing required parameter: address')
            e.code = -32602
            throw e
        }
        // Shed non-string / oversized addresses with a precise invalid-params
        // reason before handing the value to the UTXO tracker.
        try {
            validator.validateAddress(address)
        } catch (err) {
            const e = new Error(err.message)
            e.code = -32602
            throw e
        }

        try {
            let result = await encoder.utxoTrackerConnector.getUtxosFromAddress(address)
            return result
        } catch (err) {
            logger.error(util.format('UTXO fetch error:', err))
            const e = new Error(upstreamErrorMessage(err, 'UTXO fetch failed'))
            e.code = -32603
            throw e
        }
    }
}
}

// Made here rather than at module scope because the methods close over the
// encoder and network the entry builds from its environment, so requiring this
// file constructs nothing. Group order is the dispatch table's key order.
function createJsonRpcController({ encoder, NETWORK }) {
    return Object.assign(
        buildReadinessMethods({ encoder }),
        buildFeeMethods({ encoder, NETWORK }),
        buildTransactionMethods({ encoder }),
        buildCancelMethods({ encoder }),
        buildReleaseMethods({ encoder }),
        buildBroadcastMethods({ encoder }),
        buildUtxoMethods({ encoder })
    )
}

module.exports = { createJsonRpcController }
