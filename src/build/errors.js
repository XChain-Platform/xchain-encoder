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
 * XChain Encoder - Typed operational errors
 *
 * A caller-actionable failure the encoder can name precisely: no spendable
 * UTXOs, an under-funded selection, a missing change address, an unreachable
 * or stale tracker. These are distinct from an unexpected internal (a bug, an upstream
 * transport failure that embeds host:port). api.js forwards an OperationalError
 * message + its stable `xchainCode` to the caller, but collapses everything
 * else to a generic message so internals and credentials never reach a
 * response. The message here is encoder-authored; any upstream text it embeds
 * (a tracker error or halt reason) has first passed safeUpstreamReason
 * (leak-checked, printable ASCII, length-capped), so it is safe to forward.
 *
 ********************************************************************/

class OperationalError extends Error {
    // `code` is a stable, machine-readable string (e.g. 'INSUFFICIENT_FUNDS')
    // callers can branch on; `details` is an optional plain-object payload
    // (e.g. { required, available }) surfaced in the JSON-RPC error `data`.
    constructor(code, message, details) {
        super(message)
        this.name = 'OperationalError'
        this.operational = true
        this.xchainCode = code
        if (details) this.details = details
    }
}

// A caller-input rejection the encoder raised itself, so its message is safe to
// return as -32602. A bare TypeError/RangeError from Node or a library is a bug and
// stays unmarked. `name` is inherited, so instanceof and name checks still match.
class ParamTypeError extends TypeError {
    constructor(message) {
        super(message)
        this.invalidParams = true
    }
}

// The RangeError twin of ParamTypeError: a caller value of the right type out of bounds.
class ParamRangeError extends RangeError {
    constructor(message) {
        super(message)
        this.invalidParams = true
    }
}

// Whether an error is an encoder-authored caller-input rejection.
function isInvalidParams(err) {
    return Boolean(err) && err.invalidParams === true
}

module.exports = { OperationalError, ParamTypeError, ParamRangeError, isInvalidParams }
