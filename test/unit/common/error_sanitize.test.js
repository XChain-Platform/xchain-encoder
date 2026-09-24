/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

const assert = require('assert')
const { upstreamErrorMessage, isTransportError, leaksInternalDetail, safeUpstreamReason, MAX_UPSTREAM_REASON_CHARS } = require('../../../src/common/error_sanitize')

// Guards the encoder's outbound error sanitization: useful upstream RPC reasons
// pass through, transport-level failures (which leak the internal node host:port)
// are replaced with a generic fallback. See xchain-encoder/src/api.js
// broadcast_tx / get_utxos handlers.
describe('errorSanitize.upstreamErrorMessage', () => {
    const FALLBACK = 'Transaction broadcast failed'

    it('genericizes an ECONNREFUSED transport error that leaks host:port', () => {
        const err = new Error('connect ECONNREFUSED 10.0.0.5:8332')
        err.code = 'ECONNREFUSED'
        assert.strictEqual(upstreamErrorMessage(err, FALLBACK), FALLBACK)
    })

    it('genericizes an axios transport failure with no response', () => {
        const err = new Error('connect ETIMEDOUT 10.0.0.5:8332')
        err.isAxiosError = true
        // no .response -> request made, nothing received
        assert.strictEqual(upstreamErrorMessage(err, FALLBACK), FALLBACK)
    })

    it('forwards a genuine coin-node rejection reason (safe + useful)', () => {
        const err = new Error('min relay fee not met, 0 < 110')
        assert.strictEqual(upstreamErrorMessage(err, FALLBACK), 'min relay fee not met, 0 < 110')
    })

    it('forwards a bad-txns rejection reason', () => {
        const err = new Error('bad-txns-inputs-missingorspent')
        assert.strictEqual(upstreamErrorMessage(err, FALLBACK), 'bad-txns-inputs-missingorspent')
    })

    it('falls back when the error has no message', () => {
        assert.strictEqual(upstreamErrorMessage(null, FALLBACK), FALLBACK)
        assert.strictEqual(upstreamErrorMessage({}, FALLBACK), FALLBACK)
    })
})

describe('errorSanitize.upstreamErrorMessage', () => {
    const FALLBACK = 'Transaction broadcast failed'

    it('isTransportError matches network errnos but not application errors', () => {
        assert.strictEqual(isTransportError({ code: 'ENOTFOUND' }), true)
        assert.strictEqual(isTransportError({ code: 'ECONNRESET' }), true)
        assert.strictEqual(isTransportError(new Error('dust')), false)
    })

    // Every re-wrap between the socket and this helper builds a plain Error and
    // drops err.code, so a connect failure arrives UNCLASSIFIABLE. These pin the
    // second gate: an unclassified error is never safe to forward verbatim.
    it('collapses a credentialed RPC URL that arrives with no transport code', () => {
        const err = new Error('Error in network request: connect to http://user:secret@10.0.0.5:8332 failed')
        assert.strictEqual(isTransportError(err), false, 'the re-wrap has stripped the errno')
        const out = upstreamErrorMessage(err, FALLBACK)
        assert.strictEqual(out, FALLBACK)
        assert.ok(!out.includes('user:secret'), 'no credentials survive')
        assert.ok(!out.includes('10.0.0.5'), 'no host survives')
    })

    it('collapses bare topology: a dotted quad, a host:port, and a scheme', () => {
        for (const message of [
            'Error getting utxos: tracker at 10.0.0.7 is unreachable',
            'Error in network request: btc-node.internal:8332 refused the call',
            'upstream said https://utxo-tracker.internal/rpc returned nothing'
        ]) {
            assert.strictEqual(upstreamErrorMessage(new Error(message), FALLBACK), FALLBACK, message)
        }
    })

    // The wallet's broadcast-permanence classifier substring-matches these exact
    // reasons (xchain-wallet/packages/core/src/flows/broadcastPermanence.js), so
    // collapsing them would silently turn a permanent failure into a retry loop.
    it('still forwards node reasons the wallet classifies on', () => {
        for (const reason of [
            'min relay fee not met, 0 < 110',
            'bad-txns-inputs-missingorspent',
            'dust',
            'too-long-mempool-chain',
            'Error getting utxos: [ADDRESS_TOO_LARGE] address has too many utxos'
        ]) {
            assert.strictEqual(upstreamErrorMessage(new Error(reason), FALLBACK), reason, reason)
            assert.strictEqual(leaksInternalDetail(reason), false, reason)
        }
    })
})

describe('errorSanitize.safeUpstreamReason', () => {
    it('passes a plain reason through verbatim', () => {
        const reason = 'rolled back past the recovery window'
        assert.strictEqual(safeUpstreamReason(reason), reason)
    })

    it('collapses a reason carrying an endpoint, address or URL to null', () => {
        for (const reason of [
            'connect ECONNREFUSED 10.0.0.5:8332',
            'postgres://user:pass@db.internal:5432/utxo',
            'reorg below tip while reading from node.internal:8332'
        ]) {
            assert.strictEqual(safeUpstreamReason(reason), null, reason)
        }
    })

    it('leak-checks the whole string before capping, so a cut cannot hide an endpoint', () => {
        const reason = 'x'.repeat(MAX_UPSTREAM_REASON_CHARS - 4) + ' 10.0.0.5:8332'
        assert.strictEqual(safeUpstreamReason(reason), null)
    })

    it('caps length and strips control characters', () => {
        assert.strictEqual(safeUpstreamReason('a'.repeat(1000)).length, MAX_UPSTREAM_REASON_CHARS)
        assert.strictEqual(safeUpstreamReason('line one\nline\u0000two'), 'line one line two')
    })

    it('returns null for an oversized, empty, blank or non-string reason', () => {
        for (const value of ['a'.repeat(5000), '', '   ', '\n\t', undefined, null, 42, {}]) {
            assert.strictEqual(safeUpstreamReason(value), null, JSON.stringify(value))
        }
    })
})
