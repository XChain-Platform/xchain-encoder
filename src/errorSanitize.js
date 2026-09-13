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
 * Transport CLASSIFICATION alone is not proof a message is safe. Every
 * re-wrap between the socket and here (BlockchainConnector, UtxoTracker,
 * XChainEncoder) builds a plain Error and drops err.code, so a connect
 * failure carrying an RPC URL with embedded credentials arrives looking
 * exactly like an application rejection. So the caller-safe message is
 * gated twice: not a classified transport error, AND carrying none of the
 * shapes that can only be the encoder's own topology or credentials.
 * A message that trips the second gate is collapsed WHOLE rather than
 * scrubbed: redacting the part we recognized still ships everything else
 * the upstream chose to say, which is the same enumerate-the-bad mistake
 * as classifying by errno.
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

// Shapes an upstream application rejection never needs and the encoder's own
// plumbing routinely carries. Node reasons are prose and opcode-ish tokens
// ("min relay fee not met, 0 < 110", "bad-txns-inputs-missingorspent",
// "dust"), so none of these fire on the reasons that are worth forwarding.
const INTERNAL_DETAIL_PATTERNS = [
    // Any URL, which is also the only shape that can carry user:pass@host.
    /[a-z][a-z0-9+.-]*:\/\//i,
    // A dotted quad, with or without a port.
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
    // host:port, where the host has at least one letter so a bare clock or
    // ratio ("12:30", "0 < 110") is not mistaken for an endpoint.
    /[a-z0-9_-]*[a-z][a-z0-9_.-]*:\d{2,5}\b/i
]

// True when the message carries encoder-internal topology or credentials.
function leaksInternalDetail(message) {
    if (typeof message !== 'string' || message.length === 0) return false
    return INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(message))
}

// Return a caller-safe message: the upstream reason for application-level
// rejections, the generic fallback for a transport-level failure or for any
// message carrying internal topology or credentials.
function upstreamErrorMessage(err, fallback) {
    if (isTransportError(err)) return fallback
    const message = (err && err.message) || ''
    if (message === '' || leaksInternalDetail(message)) return fallback
    return message
}

module.exports = { isTransportError, upstreamErrorMessage, leaksInternalDetail }
