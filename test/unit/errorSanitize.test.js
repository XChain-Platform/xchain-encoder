const assert = require('assert')
const { upstreamErrorMessage, isTransportError } = require('../../src/errorSanitize')

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

    it('isTransportError matches network errnos but not application errors', () => {
        assert.strictEqual(isTransportError({ code: 'ENOTFOUND' }), true)
        assert.strictEqual(isTransportError({ code: 'ECONNRESET' }), true)
        assert.strictEqual(isTransportError(new Error('dust')), false)
    })
})
