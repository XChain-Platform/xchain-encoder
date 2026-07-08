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
 * tracker. These are distinct from an unexpected internal (a bug, an upstream
 * transport failure that embeds host:port). api.js forwards an OperationalError
 * message + its stable `xchainCode` to the caller, but collapses everything
 * else to a generic message so internals and credentials never reach a
 * response. The message here is always encoder-authored (never an upstream
 * string), so it is safe to forward by construction.
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

module.exports = { OperationalError }
