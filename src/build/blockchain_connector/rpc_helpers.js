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
 ********************************************************************/

const config = require('../../common/config');
const { DEFAULT_FEE_ESTIMATE_SANITY_CEILING } = require('./constants');

// Fee-rate multiple of the node's relay floor used on non-mainnet chains when
// estimatesmartfee has no data. Rationale at getFeePerKilobyte.
//
// Ten is the documented recommended rate, and on Dogecoin testnet it is NOT
// enough to be mined: measured over 400 blocks there, transactions land at
// 0.03 and around 1.0 DOGE per kB, while 0.0102 sat unmined for an hour. The
// one that did land below that paid 0.0044 and got in on legacy coin-age
// priority, which a chain of freshly spent change can never have. So the
// multiple is deployment-tunable: a quiet chain whose miners ignore the
// documented rate needs a higher one, and only the operator running that chain
// can measure what it actually takes.
function noEstimateRelayMultiplier(){
    const raw = parseFloat(config.FEE_NO_ESTIMATE_RELAY_MULTIPLIER)
    return (Number.isFinite(raw) && raw > 0) ? raw : 10
}

function feeEstimateSanityCeiling(){
    const override = parseFloat(config.FEE_ESTIMATE_SANITY_CEILING)
    if (Number.isFinite(override) && override > 0) return override
    const coin = String(config.NETWORK).split('-')[0].toLowerCase()
    return DEFAULT_FEE_ESTIMATE_SANITY_CEILING[coin] || DEFAULT_FEE_ESTIMATE_SANITY_CEILING.bitcoin
}

// Sanitize an axios error before it is logged or re-thrown. RPC calls pass
// auth:{username,password} to axios, which attaches the request config to the
// thrown error, so logging the raw error serializes the node RPC password into
// the encoder logs (util.inspect walks error.config.auth). Scrub the credential
// fields in place so neither this logger nor any upstream handler leaks them, and
// return a compact, credential-free string (error.message never carries auth).
// Kept in sync with xchain-decoder/src/chain/blockchain_connector.js sanitizeRpcError.
function sanitizeRpcError(error){
    try {
        if (error && error.config) {
            error.config.auth = undefined
            if (error.config.headers) delete error.config.headers.Authorization
        }
        if (error && error.request) error.request = undefined
        if (error && error.response) {
            const status = error.response.status
            error.response = (status !== undefined) ? { status: status } : undefined
        }
    } catch (_) { /* sanitization must never mask the original failure */ }
    return (error && error.message) ? error.message : String(error)
}

// Size and fee off one getmempoolentry-shaped record, across both field layouts
// the fleet's nodes use: Core 0.14 (Dogecoin 1.14) reports flat `size` and `fee`,
// while modern Core reports `vsize` and nests the fee under `fees.base`. Either
// reader returns null on a value it cannot price, which the caller treats as an
// unusable package rather than as a zero-fee ancestor.
// The node's own JSON-RPC error as a compact suffix, off either response shape
// the fleet produces: BTC v28 answers HTTP 200 with an error body, while
// LTC/DOGE answer HTTP 500 and axios hangs the body off error.response. Returns
// '' when there is no error body, so a pure transport failure reads exactly as
// it did before. Must be read BEFORE sanitizeRpcError, which scrubs
// error.response down to its status.
function rpcErrorDetail(body){
    const rpcError = body && body.error
    if (!rpcError || typeof rpcError !== 'object') return ''
    const code = rpcError.code
    const message = rpcError.message || ''
    if (code === undefined && message === '') return ''
    return ` (RPC error ${code === undefined ? 'unknown' : code}: ${message})`
}

// Type before coercion: Number(null), Number('') and Number(false) are all a
// finite 0, and Number(true) is 1, so a bare Number() cast turns an unreadable
// field into a priceable value. Only real numbers, and strings that spell one,
// are priceable; anything else is null and invalidates the package.
function readNumeric(raw){
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (trimmed === '') return null
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function entrySize(entry){
    const raw = entry && (entry.vsize !== undefined ? entry.vsize : entry.size)
    const size = readNumeric(raw)
    return (size !== null && size > 0) ? size : null
}

function entryFee(entry){
    const raw = entry && (entry.fees && entry.fees.base !== undefined ? entry.fees.base : entry.fee)
    const fee = readNumeric(raw)
    return (fee !== null && fee >= 0) ? fee : null
}

module.exports = {
    noEstimateRelayMultiplier,
    feeEstimateSanityCeiling,
    sanitizeRpcError,
    rpcErrorDetail,
    readNumeric,
    entrySize,
    entryFee,
}
