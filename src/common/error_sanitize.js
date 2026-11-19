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
 * missingorspent", "dust") are useful to classify, but their text remains
 * upstream-authored. The encoder returns fixed messages for recognized
 * reasons and collapses everything else. A *transport* failure is different -
 * the raw axios error is rethrown and its message embeds the internal
 * host:port behind the encoder (e.g. "connect ECONNREFUSED 10.0.0.5:8332").
 * On an open-by-default service that is topology recon, so transport errors
 * are replaced with a generic fallback.
 *
 * Transport CLASSIFICATION alone is not proof a message is safe. Every
 * re-wrap between the socket and here (BlockchainConnector, UtxoTracker,
 * XChainEncoder) builds a plain Error and drops err.code, so a connect
 * failure carrying an RPC URL with embedded credentials arrives looking
 * exactly like an application rejection. Caller-safe text is therefore
 * selected from encoder-owned messages only: a fixed rendering of a
 * recognized reason, or an error the encoder built with callerSafeError.
 * The topology check runs first on both.
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
    /[a-z0-9_-]*[a-z][a-z0-9_.-]*:\d{2,5}\b/i,
    // Node's DNS errors always append the host after this operation name.
    /\bgetaddrinfo\b/i,
    // Bracketed or bare IPv6, optionally followed by a port. At least two
    // colons keeps ordinary prose, ratios and clock times out of this gate.
    /\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d{1,5})?/i,
    /(?:^|[\s(])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*(?=$|[\s),;])/i
]

// True when the message carries encoder-internal topology or credentials.
function leaksInternalDetail(message) {
    if (typeof message !== 'string' || message.length === 0) return false
    return INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(message))
}

const NODE_REASON_RULES = [
    { code: 'INPUTS_MISSING_OR_SPENT', test: /missing\s*or\s*spent|missingorspent|bad-txns-inputs-spent|missing\s+inputs|already\s+spent/i,
        render: () => 'bad-txns-inputs-missingorspent' },
    { code: 'SPEND_CONFLICT', test: /bad-txns-spends-conflicting-tx|txn-mempool-conflict|rejecting\s+replacement/i,
        render: () => 'txn-mempool-conflict' },
    { code: 'REPLACEMENT_FEE', test: /insufficient fee[^\r\n]{0,80}replacement|replacement-adds-unconfirmed|too\s+many\s+potential\s+replacements/i,
        render: () => 'insufficient fee for replacement' },
    { code: 'TX_ALREADY_IN_CHAIN', test: /txn-already-known|txn-already-in-mempool|already\s+in\s+(?:the\s+)?block\s*chain/i,
        render: () => 'txn-already-known' },
    { code: 'DUST', test: /\bdust\b/i, render: () => 'dust' },
    { code: 'SCRIPT_VERIFY_FAILED', test: /script-verify-flag/i, render: () => 'script-verify-flag-failed' },
    { code: 'MEMPOOL_CHAIN_TOO_LONG', test: /too-long-mempool-chain/i, render: () => 'too-long-mempool-chain' },
    { code: 'MEMPOOL_FULL', test: /mempool[^\r\n]{0,40}full/i, render: () => 'mempool full' },
    { code: 'MEMPOOL_MIN_FEE', test: /mempool min fee/i, render: () => 'mempool min fee not met' },
    { code: 'MIN_RELAY_FEE', test: /min relay fee/i, render: renderRelayFeeReason },
    { code: 'INSUFFICIENT_PRIORITY', test: /insufficient priority/i, render: () => 'insufficient priority' },
    { code: 'RATE_LIMITED', test: /rate.?limit/i, render: () => 'rate limit exceeded' },
    { code: 'MAX_FEE_RATE', test: /maxfeerate|fee exceeds maximum/i, render: () => 'fee exceeds maximum configured by maxfeerate' },
    { code: 'NODE_WARMING_UP', test: /RPC error -28|loading block index/i, render: () => 'node is warming up (RPC error -28)' }
]

// Fee amounts are short; a longer digit run is upstream-chosen data and is not echoed.
function renderRelayFeeReason(message) {
    const amounts = String(message).match(/(?<!\d)(\d{1,12})\s*<\s*(\d{1,12})(?!\d)/)
    return amounts ? `min relay fee not met, ${amounts[1]} < ${amounts[2]}` : 'min relay fee not met'
}

function canonicalNodeReason(message) {
    if (typeof message !== 'string' || leaksInternalDetail(message)) return null
    const rule = NODE_REASON_RULES.find(candidate => candidate.test.test(message))
    return rule ? { code: rule.code, message: rule.render(message) } : null
}

const TRACKER_ERROR_MESSAGES = Object.freeze({
    ADDRESS_TOO_LARGE: 'address has too many utxos',
    INVALID_CURSOR: 'invalid pagination cursor',
    BAD_REQUEST: 'request rejected'
})

// Only a code the encoder already knows is echoed: a symbolic one from the fixed
// table, or a JSON-RPC-sized integer. Any other code is upstream-chosen text, so
// it is dropped and the message names no code at all.
const MAX_ECHOED_NUMERIC_CODE = 32768

function trackerErrorMessage(rawCode) {
    const numeric = Number.isSafeInteger(rawCode) && Math.abs(rawCode) <= MAX_ECHOED_NUMERIC_CODE ? String(rawCode) : null
    const symbolic = typeof rawCode === 'string' && Object.hasOwn(TRACKER_ERROR_MESSAGES, rawCode) ? rawCode : null
    const code = numeric || symbolic
    if (!code) return 'Error getting utxos: utxo-tracker refused the request'
    const reason = symbolic ? TRACKER_ERROR_MESSAGES[symbolic] : 'utxo-tracker refused the request'
    return `Error getting utxos: [${code}] ${reason}`
}

function canonicalTrackerError(message) {
    if (typeof message !== 'string') return null
    const match = message.match(/^Error getting utxos: \[(-?\d+|[A-Z][A-Z0-9_]{1,63})\](?:\s|$)/)
    return match ? trackerErrorMessage(/^-?\d+$/.test(match[1]) ? Number(match[1]) : match[1]) : null
}

// Errors the encoder wrote itself, tracked by object identity: upstream data can
// shape a message but cannot produce one of these objects, and a re-wrap drops it.
const callerSafeErrors = new WeakSet()

// An Error whose message is encoder-written and safe to show a caller, so the
// sanitizer passes it through once the endpoint check has also cleared it.
function callerSafeError(message) {
    const err = new Error(message)
    Error.captureStackTrace(err, callerSafeError)
    callerSafeErrors.add(err)
    return err
}

// A tracker-reported number for a caller-safe message. Like the relay-fee
// amounts above, only a short integer is echoed; anything else is upstream-chosen data.
const MAX_ECHOED_TRACKER_NUMBER = 999999999999

function trackerNumber(value, unknown = 'an unrecognized value') {
    return Number.isSafeInteger(value) && Math.abs(value) <= MAX_ECHOED_TRACKER_NUMBER ? String(value) : unknown
}

function trackerBlockCount(value) {
    return trackerNumber(value, 'an unknown number of')
}

// Return encoder-authored text for a recognized upstream rejection, or the
// generic fallback for transports, unknown text and internal detail.
function upstreamErrorMessage(err, fallback) {
    if (isTransportError(err)) return fallback
    const message = (err && err.message) || ''
    if (message === '' || leaksInternalDetail(message)) return fallback
    if (callerSafeErrors.has(err)) return message
    const trackerMessage = canonicalTrackerError(message)
    if (trackerMessage) return trackerMessage
    const nodeReason = canonicalNodeReason(message)
    return nodeReason ? nodeReason.message : fallback
}

function nodeReasonCode(err) {
    const reason = canonicalNodeReason((err && err.message) || '')
    return reason ? reason.code : null
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

function knownTrackerReason(value) {
    const reason = safeUpstreamReason(value)
    if (!reason) return null
    if (/rolled back past (?:the )?(?:recovery|tracked|undo) window/i.test(reason)) {
        return 'rolled back past the recovery window'
    }
    if (/^unrecoverable reorg$/i.test(reason)) return 'unrecoverable reorg'
    return null
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

module.exports = {
    isTransportError, upstreamErrorMessage, nodeReasonCode, leaksInternalDetail,
    safeUpstreamReason, knownTrackerReason, trackerErrorMessage, callerSafeError, trackerNumber, trackerBlockCount,
    NODE_REASON_RULES, MAX_UPSTREAM_REASON_CHARS, logErrorOnce
}
