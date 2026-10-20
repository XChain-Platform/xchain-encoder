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
 * create_envelope_cancel_tx refuses an unknown top-level param, the rule
 * create_tx already follows: create_tx's rbf or a misspelled feePerKb must
 * fail loudly rather than build the cancel under the default policy.
 ********************************************************************/

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const v = require('../../../../../src/common/validator.js');
const { VALID_CREATE_ENVELOPE_CANCEL_PARAMS } = require('../../../../../src/common/validator/constants.js');
const { ParamTypeError } = require('../../../../../src/build/errors');
const { spec } = require('../../../../../docs/openrpc.build.js');
const XChainEncoder = require('../../../../../src/XChainEncoder');
const { createJsonRpcController } = require('../../../../../src/api/json_rpc_methods.js');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7));
const COMMIT_TXID = 'a'.repeat(64);

// An encoder whose node and tracker are stubs, so a cancel builds offline.
function makeEncoder() {
    const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '');
    encoder.connector = {
        assertNodeTier: async () => {},
        getFeePerKilobyte: async () => 0.00001,
        getNetworkInfo: async () => ({ relayfee: 0.00001 }),
        getTransactionHex: async () => { throw new Error('unit test: no node'); }
    };
    encoder.utxoTrackerConnector = {
        getUtxosFromAddress: async () => { throw new Error('unit test: no tracker'); }
    };
    return encoder;
}

// The persisted recovery record a wallet replays a cancel from.
function cancelRecord(encoder, extra) {
    return Object.assign({
        commitTxid: COMMIT_TXID,
        commitVout: 0,
        commitValue: 100000,
        internalPubkey: Buffer.from(KEY.publicKey).toString('hex'),
        tapleafHash: 'c'.repeat(64),
        destination: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network: encoder.network }).address
    }, extra || {});
}

describe('Encoder input validator', function () {
    describe('create_envelope_cancel_tx unknown top-level params', function () {
        it('refuses each misspelled money-path setting and names the key', function () {
            for (const key of ['rbf', 'feeperkb', 'feePerKB', 'replaceByFee', 'commitTXID']) {
                assert.throws(() => v.validateEnvelopeCancelParamKeys({ commitTxid: COMMIT_TXID, [key]: true }), (err) => {
                    assert.ok(err instanceof ParamTypeError, `${key}: ${err && err.constructor.name}`);
                    assert.match(err.message, new RegExp(`Unknown create_envelope_cancel_tx param: "${key}"`));
                    return true;
                });
            }
        });

        it('refuses a params bag that is not an object', function () {
            for (const params of [null, [], 'commitTxid', 7]) {
                assert.throws(() => v.validateEnvelopeCancelParamKeys(params), ParamTypeError);
            }
        });

        it('accepts every documented param', function () {
            const all = {};
            for (const key of VALID_CREATE_ENVELOPE_CANCEL_PARAMS) all[key] = null;
            assert.doesNotThrow(() => v.validateEnvelopeCancelParamKeys(all));
        });

        it('keeps the allow-list equal to the published create_envelope_cancel_tx params', function () {
            const cancel = spec.methods.find((m) => m.name === 'create_envelope_cancel_tx');
            const declared = cancel.params.map((p) => p.name).sort();
            assert.ok(declared.length >= 6, `extraction too small: ${declared.length}`);
            assert.deepStrictEqual([...VALID_CREATE_ENVELOPE_CANCEL_PARAMS].sort(), declared);
        });

        it('refuses the unknown key ahead of any other field error and before the outpoint claim', async function () {
            const encoder = makeEncoder();
            await assert.rejects(encoder.createEnvelopeCancelTransaction(cancelRecord(encoder, { tapleafHash: 'zz', rbf: true })),
                /Unknown create_envelope_cancel_tx param: "rbf"/);
            assert.strictEqual(encoder.outpointReservations.size, 0);
        });

        it('builds the same record once the unknown key is gone (control)', async function () {
            const encoder = makeEncoder();
            const result = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder, { replacebyfee: true }));
            assert.strictEqual(result.cancel, true);
            assert.ok(encoder.outpointReservations.size > 0);
        });

        it('answers -32602 over JSON-RPC for create_tx\'s rbf in place of replacebyfee', async function () {
            const encoder = makeEncoder();
            const controller = createJsonRpcController({ encoder, NETWORK: 'bitcoin-regtest' });
            let err;
            try { await controller.create_envelope_cancel_tx(cancelRecord(encoder, { rbf: true })); } catch (e) { err = e; }
            assert.ok(err, 'expected a refusal');
            assert.strictEqual(err.code, -32602);
            assert.match(err.message, /"rbf"/);
            assert.strictEqual(encoder.outpointReservations.size, 0);
        });
    });
});
