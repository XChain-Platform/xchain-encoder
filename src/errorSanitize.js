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
 * XChain Encoder - Outbound error sanitization
 *
 * The encoder proxies the coin node and the UTXO tracker. Their RPC
 * *rejections* (e.g. "min relay fee not met", "bad-txns-inputs-
 * missingorspent", "dust") are safe and useful to echo to the caller:
 * BlockchainConnector/UtxoTracker convert those into a plain Error whose
 * message is the node's own reason. A *transport* failure is different -
 * the raw axios error is rethrown and its message embeds the internal
 * host:port behind the encoder (e.g. "connect ECONNREFUSED 10.0.0.5:8332").
 * On an open-by-default service that is topology recon, so transport errors
 * are replaced with a generic fallback while genuine upstream reasons pass
 * through.
 *
 ********************************************************************/

// Node network errnos (plus the axios "bad response" wrapper) that indicate a
// transport-level failure rather than an upstream application rejection.
const TRANSPORT_ERROR_CODES = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND',
    'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE', 'ERR_BAD_RESPONSE'
])

function isTransportError(err) {
    if (!err) return false
    if (err.code && TRANSPORT_ERROR_CODES.has(err.code)) return true
    // axios transport failure: a request was made but no response was received.
    if (err.isAxiosError && !err.response) return true
    return false
}

// Return a caller-safe message: the upstream reason for application-level
// rejections, the generic fallback for transport-level failures.
function upstreamErrorMessage(err, fallback) {
    if (isTransportError(err)) return fallback
    return (err && err.message) || fallback
}

module.exports = { TRANSPORT_ERROR_CODES, isTransportError, upstreamErrorMessage }
