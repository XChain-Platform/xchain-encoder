// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression tests for the encoder's JSON-RPC batch-size guard, MULTISIGN
// validation, and UtxoTracker pagination bound.

const assert = require('assert')

// api.js constructs the encoder at require time from env. Set placeholders ONLY for the
// require, then restore, so this file does not pollute process.env for other test files in
// the same mocha run (a leaked NETWORK/NODE_* changes their fixtures).
const _envKeys = ['NETWORK', 'NODE_URL', 'NODE_PORT', 'NODE_USER', 'NODE_PASSWORD']
const _savedEnv = {}
for (const k of _envKeys) {
    _savedEnv[k] = process.env[k]
    if (process.env[k] === undefined) {
        process.env[k] = (k === 'NETWORK') ? 'bitcoin-regtest' : (k === 'NODE_PORT') ? '8333' : 'x'
    }
}
const { makeRpcBatchGuard } = require('../../src/api')
for (const k of _envKeys) {
    if (_savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = _savedEnv[k]
}
const v = require('../../src/validator')
const axios = require('axios')
const UtxoTracker = require('../../src/UtxoTracker')

describe('encoder stress-sweep unit @regression', function () {
    this.timeout(10000)

    describe('JSON-RPC batch-size guard', function () {
        function fakeRes(){
            return { _code: null, _json: null, status(c){ this._code = c; return this }, json(o){ this._json = o; return this } }
        }
        it('rejects an over-cap batch array with 400 and does not call next', function () {
            const res = fakeRes()
            let next = false
            makeRpcBatchGuard(20)({ body: new Array(21).fill({ method: 'estimate_fee' }) }, res, () => { next = true })
            assert.strictEqual(res._code, 400)
            assert.strictEqual(next, false)
            assert.ok(res._json && res._json.error)
        })
        it('passes a batch at the cap and a single request', function () {
            let n1 = false, n2 = false
            makeRpcBatchGuard(20)({ body: new Array(20).fill({ method: 'ping' }) }, fakeRes(), () => { n1 = true })
            makeRpcBatchGuard(20)({ body: { method: 'ping' } }, fakeRes(), () => { n2 = true })
            assert.ok(n1 && n2)
        })
    })

    describe('MULTISIGN requires compressedPubKey', function () {
        it('validateAll throws when encoding is MULTISIGN and compressedPubKey is absent', function () {
            assert.throws(
                () => v.validateAll({ data: 'SEND|JDOG|1|addr', pubkey: 'senderaddr', encoding: 'MULTISIGN' }),
                /compressedPubKey is required for MULTISIGN/
            )
        })
        it('validateAll accepts MULTISIGN when compressedPubKey is present', function () {
            const out = v.validateAll({
                data: 'SEND|JDOG|1|addr', pubkey: 'senderaddr', encoding: 'MULTISIGN',
                compressedPubKey: '02' + 'a'.repeat(64)
            })
            assert.strictEqual(out.encoding, 'MULTISIGN')
        })
    })

    describe('UtxoTracker pagination is bounded', function () {
        const origPost = axios.post
        afterEach(() => { axios.post = origPost })

        it('aborts on a repeated pagination cursor (stalled/hostile tracker)', async function () {
            let call = 0
            axios.post = async () => {
                call++
                if (call === 1) return { data: { result: { synced: true, lag: 0 } } }
                // Every page returns the SAME nextCursor -> the loop would run forever.
                return { data: { result: {
                    utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 1000, scriptPubKey: '0014' + '11'.repeat(20) }],
                    nextCursor: 'STUCK'
                } } }
            }
            const tracker = new UtxoTracker('127.0.0.1', '1234')
            await assert.rejects(() => tracker.getUtxosFromAddress('someaddr'), /repeated pagination cursor|more than \d+ pages/)
        })
    })
})
