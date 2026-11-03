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

// Longest upstream reason forwarded, and the longest one worth leak-checking at all.
const MAX_UPSTREAM_REASON_CHARS = 120
const MAX_CHECKED_REASON_CHARS = 4096

// Return an upstream-authored reason string safe to echo in a public error, or
// null. The whole string is leak-checked before it is cut, so a cap cannot
// halve an endpoint into something the patterns miss; a leaking or oversized
// reason collapses whole, as upstreamErrorMessage does.
function safeUpstreamReason(value) {
    if (typeof value !== 'string' || value.length > MAX_CHECKED_REASON_CHARS) return null
    if (leaksInternalDetail(value)) return null
    const printable = value.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, MAX_UPSTREAM_REASON_CHARS).trim()
    return printable === '' ? null : printable
}

// Log-line bounds. A thrown AxiosError carries its config, the ClientRequest
// with its socket, and the response headers; formatting the whole object wrote
// about 13 KB per failure, so a burst of rate-limited tracker calls rotated
// away the container's whole log retention. A log line names the failure and
// where it was raised, nothing more.
const MAX_LOG_MESSAGE_CHARS = 300
const MAX_LOG_FRAMES = 4
const MAX_LOG_FRAME_CHARS = 160
const MAX_LOG_LINE_CHARS = 900

// Strip control characters so one record stays one line of printable text.
function printable(text, max) {
    return String(text).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max)
}

// The encoder's own frames from a stack; library and runtime frames (axios
// internals, node: modules) say nothing about which caller hit the failure.
function appFrames(stack) {
    if (typeof stack !== 'string') return []
    return stack.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at ') && !line.includes('node_modules') && !line.includes('node:'))
        .slice(0, MAX_LOG_FRAMES)
        .map((line) => printable(line, MAX_LOG_FRAME_CHARS))
}

// One bounded line describing an error for the encoder's own log: its name and
// code, the HTTP status of an upstream reply, the message, and a few of the
// encoder's stack frames. Only those fields are read, so no request config,
// socket or header ever reaches the log whatever the error object carries.
function describeErrorForLog(err) {
    if (err === null || typeof err !== 'object') return printable(err, MAX_LOG_MESSAGE_CHARS)
    const parts = [printable(err.name || 'Error', 60)]
    if (typeof err.code === 'string' || typeof err.code === 'number') parts.push(`[${printable(err.code, 60)}]`)
    const status = err.response && err.response.status
    if (Number.isInteger(status)) parts.push(status === 429 ? 'HTTP 429 (rate limited)' : `HTTP ${status}`)
    let line = `${parts.join(' ')}: ${printable(err.message || '', MAX_LOG_MESSAGE_CHARS)}`
    const frames = appFrames(err.stack)
    if (frames.length > 0) line += ` | ${frames.join(' | ')}`
    return line.slice(0, MAX_LOG_LINE_CHARS)
}

// Errors already logged once. A failure rethrown up the stack would otherwise
// be logged again at every layer that catches it.
const loggedErrors = new WeakSet()

// Log `prefix` plus the bounded description of err at error level, once per error object.
function logErrorOnce(logger, prefix, err) {
    const trackable = err !== null && (typeof err === 'object' || typeof err === 'function')
    if (trackable && loggedErrors.has(err)) return false
    if (trackable) loggedErrors.add(err)
    logger.error(`${prefix} ${describeErrorForLog(err)}`)
    return true
}

module.exports = { isTransportError, upstreamErrorMessage, leaksInternalDetail, safeUpstreamReason, MAX_UPSTREAM_REASON_CHARS, describeErrorForLog, logErrorOnce, MAX_LOG_LINE_CHARS }
