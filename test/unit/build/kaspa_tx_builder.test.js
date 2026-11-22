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
 * Kaspa transaction builder: the fee rule and the two-pass build.
 *
 * The wasm SDK is faked here on purpose. What has to be pinned is not the SDK
 * but the two things that were wrong before this module existed: the fee has to
 * come from mass (the SDK's own feeAmount was measured below the relay minimum),
 * and a build that ends up under-fee'd must throw instead of broadcasting.
 **********************************************************************/
'use strict';

const assert = require('assert');

const builder = require('../../../src/build/kaspa_tx_builder.js');
const { buildAndSign } = require('../../../src/build/kaspa_tx_builder.js');

// Module scope on purpose: the obfuscation key comes from the first input's txid (4.2), so
// every signable entry set in this file must carry the outpoint it spends. A set without one
// fails closed at build time -- silently writing a cleartext payload would be worse.
const ENTRIES = [{ amount: '5000000000', outpoint: { transactionId: 'aa'.repeat(32), index: 0 } }];

// A fake wasm SDK that records the priorityFee it was handed and honours it.
function fakeSdk({ mass = 10021n, honourFee = true } = {}) {
    const calls = [];
    return {
        calls,
        async createTransactions(options) {
            calls.push({ priorityFee: String(options.priorityFee), payloadBytes: options.payload.length });
            const priorityFee = BigInt(options.priorityFee);
            // A realistic shape: the action output AND the change output, so inSum - outSum is
            // exactly the fee that was asked for. The old fake folded both into a single output,
            // which made 90x the input look like a fee - the new money guard refuses that, and a
            // fake that a real SDK would never produce has no business standing in for one.
            const inSum = options.entries.reduce((s, e) => s + BigInt(e.amount), 0n);
            const action = BigInt(options.outputs[0].amount);
            const fee = honourFee ? priorityFee : 0n;
            const change = inSum - action - fee;
            const outputs = change > 0n ? [{ value: action }, { value: change }] : [{ value: inSum - fee }];
            return {
                transactions: [{
                    mass: String(mass),
                    async sign() {},
                    transaction: {
                        id: 'cc'.repeat(32),
                        outputs,
                    },
                }],
            };
        },
    };
}

describe('kaspa_tx_builder: fee rule', function () {

    it('minimum relay fee is mass x 100 sompi/gram', function () {
        assert.strictEqual(builder.SOMPI_PER_GRAM, 100n);
        // Both numbers are P0 measurements, not round figures.
        assert.strictEqual(builder.minimumFeeSompi(10021), 1002100n);
        assert.strictEqual(builder.minimumFeeSompi(18420), 1842000n);
        assert.strictEqual(builder.minimumFeeSompi('10021'), 1002100n);
        assert.throws(() => builder.minimumFeeSompi(0), /must be positive/);
        assert.throws(() => builder.minimumFeeSompi(-5), /must be positive/);
    });

    it('the relayable fee carries a margin over the minimum', function () {
        const min = builder.minimumFeeSompi(10021);
        const safe = builder.safeFeeSompi(10021);
        assert.ok(safe > min, 'margin must raise the fee');
        assert.strictEqual(safe, min + (min * 1000n) / 10000n + 1000n);
    });

    it('assertFeeSufficient throws below the minimum instead of broadcasting', function () {
        assert.strictEqual(builder.assertFeeSufficient(10021, 1002100n), true);
        assert.throws(() => builder.assertFeeSufficient(10021, 214000n), /fee insufficient/);
    });
});

describe('kaspa_tx_builder: action string', function () {

    it('accepts a normal action and reports its byte length', function () {
        const out = builder.assertActionString('ORDER|0|DOGE||1000');
        assert.strictEqual(out.action, 'ORDER|0|DOGE||1000');
        assert.strictEqual(out.bytes, Buffer.byteLength('ORDER|0|DOGE||1000', 'utf8'));
    });

    it('rejects empty, separator-less, oversize and non-ASCII payloads', function () {
        assert.throws(() => builder.assertActionString(''), /empty/);
        assert.throws(() => builder.assertActionString('ORDER'), /separator/);
        assert.throws(() => builder.assertActionString('A|' + 'x'.repeat(8192)), /too long/);
        assert.throws(() => builder.assertActionString('ORDER|0|ünïcode'), /printable ASCII/);
    });

    it('accepts the largest action that still fits once obfuscated', function () {
        // 4.3 caps the ASSEMBLED payload: raw bytes + the 4-byte magic must fit.
        const MAGIC = 4;
        const action = 'A|' + 'x'.repeat(builder.MAX_ACTION_DATA_LENGTH - 2 - MAGIC);
        assert.strictEqual(Buffer.byteLength(action, 'utf8'), builder.MAX_ACTION_DATA_LENGTH - MAGIC);
        assert.doesNotThrow(() => builder.assertActionString(action));
        const tooBig = 'A|' + 'x'.repeat(builder.MAX_ACTION_DATA_LENGTH - 1 - MAGIC);
        assert.throws(() => builder.assertActionString(tooBig), /too long/, 'one byte past the assembled ceiling must be refused');
    });
});

describe('kaspa_tx_builder: two-pass build', function () {

    // The obfuscation key comes from the first input's txid (4.2), so a signable entry set

    it('pass 1 asks for zero fee, pass 2 asks for the mass-derived fee', async function () {
        const sdk = fakeSdk({ mass: 10021n });
        const result = await builder.buildAndSign({
            sdk, entries: ENTRIES, address: 'kaspatest:x', action: 'ORDER|0|DOGE', privateKey: {},
        });

        assert.strictEqual(sdk.calls.length, 2, 'exactly two passes');
        assert.strictEqual(sdk.calls[0].priorityFee, '0');
        assert.strictEqual(sdk.calls[1].priorityFee, String(builder.safeFeeSompi(10021n)));
        assert.strictEqual(result.mass, 10021n);
        assert.ok(result.paidFee >= builder.minimumFeeSompi(result.mass));
        // 4.2: the on-chain payload is the OBFUSCATED action (magic + AES-128-CTR), so the
        // assertion is about the wire shape, not about cleartext equality.
        const actionBytes = Buffer.byteLength('ORDER|0|DOGE', 'utf8');
        assert.strictEqual(result.payloadHex.length / 2, actionBytes + 4, 'exactly the 4-byte magic wider');
        assert.notStrictEqual(result.payloadHex, Buffer.from('ORDER|0|DOGE', 'utf8').toString('hex'), 'must not be cleartext');
        assert.strictEqual(builder.deobfuscateAction(result.payloadHex, ENTRIES[0].outpoint.transactionId), 'ORDER|0|DOGE');
        assert.strictEqual(result.txid, 'cc'.repeat(32));
    });

    it('THROWS when the built transaction ends up under-fee\'d (the failure this exists to prevent)', async function () {
        // honourFee: false models the SDK dropping the priorityFee — exactly how the
        // too-low 214,000 sompi build was produced before this module existed.
        // spendKeepSompi is set small on purpose: with a 1 KAS change the shortfall
        // would still clear the relay minimum, and the guard would (correctly) not fire.
        const sdk = fakeSdk({ honourFee: false });
        await assert.rejects(() => builder.buildAndSign({
            sdk, entries: ENTRIES, address: 'kaspatest:x', action: 'ORDER|0|DOGE', privateKey: {},
            spendKeepSompi: 100000n,
        }), /fee insufficient/);
    });

    it('refuses to build without entries or without the sdk', async function () {
        await assert.rejects(() => builder.buildAndSign({ sdk: fakeSdk(), entries: [], address: 'a', action: 'A|1', privateKey: {} }),
            /at least one UTXO entry/);
        await assert.rejects(() => builder.buildAndSign({ entries: ENTRIES, address: 'a', action: 'A|1', privateKey: {} }),
            /needs the wasm sdk/);
    });

    it('refuses when the entries cannot cover the spend', async function () {
        await assert.rejects(() => builder.buildAndSign({
            sdk: fakeSdk(), entries: [{ amount: '5', outpoint: { transactionId: 'aa'.repeat(32), index: 0 } }], address: 'a', action: 'A|1', privateKey: {},
            spendKeepSompi: 100000000n,
        }), /do not cover the spend/);
    });
});

describe('kaspa_tx_builder: read-back helper', function () {

    it('normalises the payload however the node hands it back', function () {
        assert.strictEqual(builder.payloadHexOf('0xABcd'), 'abcd');
        assert.strictEqual(builder.payloadHexOf(Buffer.from([0xab, 0xcd])), 'abcd');
        assert.strictEqual(builder.payloadHexOf(null), null);
        assert.strictEqual(builder.payloadHexOf(undefined), null);
    });
});

describe('kaspa_tx_builder: exact-integer guard', function () {
    it('refuses an entry total beyond 2^53-1 sompi instead of rounding it', async function () {
        const huge = [{ amount: '9007199254740992', outpoint: { transactionId: 'aa'.repeat(32), index: 0 } }];      // 2^53, one past the exact range
        await assert.rejects(() => builder.buildAndSign({
            sdk: { async createTransactions() { throw new Error('sdk must not be called'); } },
            entries: huge, address: 'kaspatest:x', action: 'ORDER|0|DOGE', privateKey: {},
            spendKeepSompi: 1n,
        }), /exceeds the exact-integer range/);
    });
});

describe('kaspa_tx_builder: 4.2 obfuscation', function () {
    const TXID = 'aa'.repeat(32);
    it('encrypts the action, so the chain carries no cleartext keywords', function () {
        const enc = builder.obfuscateAction('ORDER|0|DOGE||1000000', TXID);
        assert.strictEqual(enc.length, Buffer.byteLength('ORDER|0|DOGE||1000000', 'utf8') + 4, 'AES-CTR is a stream cipher: exactly the 4-byte magic wider');
        assert.ok(!enc.toString('utf8').includes('ORDER'), 'naive keyword scanning must fail');
    });
    it('round-trips, and refuses a payload it did not write', function () {
        const enc = builder.obfuscateAction('ORDER|0|DOGE||1000000', TXID);
        assert.strictEqual(builder.deobfuscateAction(enc, TXID), 'ORDER|0|DOGE||1000000');
        assert.strictEqual(builder.deobfuscateAction(enc, 'bb'.repeat(32)), null, 'wrong key must not yield text');
        assert.strictEqual(builder.deobfuscateAction(Buffer.from('ORDER|0|X'), TXID), null, 'cleartext has no magic');
    });
    it('derives key and IV from the reversed first-input txid (4.2)', function () {
        const { key, iv } = builder.cipherKeyIvFromTxid(TXID);
        assert.strictEqual(key.length, 16);
        assert.strictEqual(iv.length, 16);
        assert.strictEqual(key.toString('hex'), 'aa'.repeat(16));
        assert.throws(() => builder.cipherKeyIvFromTxid('00'), /32-byte first-input txid/);
    });
});

describe('kaspa_tx_builder: money pins (M1/M2), one guard per case', function () {
    // M1 (fee upper bound) and M2 (a change output must exist) used to overlap: a swallowed
    // change tripped both, so neither could be shown to be load-bearing on its own. Each case
    // below trips exactly one of them, which is what makes the seal meaningful.
    const COIN = 100000000n;
    const entry = (amount) => ({ outpoint: { transactionId: 'ab'.repeat(32), index: 0 }, amount, address: 'kaspatest:qpz' });
    const build = (sdk, spendKeepSompi) => buildAndSign({ sdk, entries: [entry(10n * COIN)],
        address: 'kaspatest:qpz', action: 'ORDER|0|DOGE||1', privateKey: {}, networkId: 'simnet', spendKeepSompi });

    // Emits the action output and a change output, but shortens the change by 5 KAS: the shape
    // rule is satisfied, so only the fee bound can object.
    const sdkThatShrinksChange = (mass) => ({
        async createTransactions(options) {
            const inSum = options.entries.reduce((s, e) => s + BigInt(e.amount), 0n);
            const action = BigInt(options.outputs[0].amount);
            const fee = BigInt(options.priorityFee || 0n);
            const change = inSum - action - fee - 5n * COIN;
            return { transactions: [{ mass, sign: async () => {}, transaction: { id: 'cd'.repeat(32), mass,
                outputs: [{ value: action }, { value: change }] } }] };
        },
    });
    // Emits a single output, and swallows a keep small enough to stay under the fee bound.
    const sdkThatDropsChange = (mass) => ({
        async createTransactions(options) {
            const action = BigInt(options.outputs[0].amount);
            return { transactions: [{ mass, sign: async () => {}, transaction: { id: 'ef'.repeat(32), mass,
                outputs: [{ value: action }] } }] };
        },
    });
    it('surfaces a bare-string refusal from the wasm SDK instead of "undefined" (measured on testnet-10)', async function () {
        // The real shape, measured with an 8000-byte payload over 2 UTXOs: the SDK throws a bare
        // string, our call sites read error.message, and the operator saw the word "undefined".
        const sdk = { async createTransactions() { throw 'Storage mass exceeds maximum'; } };
        await assert.rejects(
            () => buildAndSign({ sdk, entries: [entry(10n * COIN)], address: 'kaspatest:qpz',
                action: 'SEND|0|XCHAIN|1', privateKey: {}, networkId: 'simnet' }),
            /Storage mass exceeds maximum[\s\S]*action SEND v0, 4 field\(s\)/,
            'a money-class refusal must reach the operator as a message, never as "undefined", ' +
            'and it must carry the action shape so a wire-format mistake is the visible suspect');
    });
    const honestSdk = (mass) => ({
        async createTransactions(options) {
            const inSum = options.entries.reduce((s, e) => s + BigInt(e.amount), 0n);
            const action = BigInt(options.outputs[0].amount);
            const fee = BigInt(options.priorityFee || 0n);
            const change = inSum - action - fee;
            const outputs = [{ value: action }];
            if (change > 0n) outputs.push({ value: change });
            return { transactions: [{ mass, sign: async () => {}, transaction: { id: 'ff'.repeat(32), mass, outputs } }] };
        },
    });

    it('M1 only: a shrunken change output is still a fat fee, so it is refused', async function () {
        await assert.rejects(() => build(sdkThatShrinksChange(5000n)), /far above the mass-derived/,
            'two outputs is not enough: the fee bound has to see it too');
    });

    it('M2 only: a single output with a small keep is refused for the missing change output', async function () {
        await assert.rejects(() => build(sdkThatDropsChange(5000n), 5000000n), /single output/,
            'the shape rule has to fire on its own, not as a side effect of the fee bound');
    });

    it('the honest SDK passes both guards and reports the fee it actually paid', async function () {
        const out = await build(honestSdk(5000n));
        assert.ok(out.paidFee >= 0n);
        assert.ok(out.paidFee <= 10n * COIN, 'not a fat fee: ' + out.paidFee);
    });
});

describe('kaspa_tx_builder: the bounded retry on the measured transient refusal', function () {
    const COIN2 = 100000000n;
    const oneEntry = () => [{ outpoint: { transactionId: 'ab'.repeat(32), index: 0 }, amount: 10n * COIN2,
        address: 'kaspatest:qpz', utxoEntry: { amount: 10n * COIN2,
        scriptPublicKey: { version: 0, scriptPublicKey: '65ab' }, blockDaaScore: 1n, isCoinbase: false } }];
    const honestBuild = async (options) => {
        // The shape a real SDK returns: the action output AND the change output, so the effective
        // fee equals what was asked for. A single inflated output would (correctly) trip the fee
        // upper bound instead of exercising the retry.
        const inSum = options.entries.reduce((sum, e) => sum + BigInt(e.amount !== undefined ? e.amount : e.utxoEntry.amount), 0n);
        const action = BigInt(options.outputs[0].amount);
        const fee = BigInt(options.priorityFee || 0n);
        const change = inSum - action - fee;
        const outputs = change > 0n ? [{ value: action }, { value: change }] : [{ value: inSum - fee }];
        return { transactions: [{ mass: 10021n, sign: async () => {},
            transaction: { id: 'cc'.repeat(32), outputs } }] };
    };

    it('retries a transient mass refusal and succeeds - measured: the same valid action was refused once, then built', async function () {
        let calls = 0;
        const sdk = { async createTransactions(options) {
            calls += 1;
            if (calls < 3) throw 'Storage mass exceeds maximum';
            return honestBuild(options);
        } };
        const out = await buildAndSign({ sdk, entries: oneEntry(), address: 'kaspatest:qpz',
            action: 'BROADCAST|0|hello world|42', privateKey: {}, networkId: 'simnet' });
        assert.ok(calls > 1, 'it must have retried: ' + calls + ' attempt(s)');
        assert.ok(calls <= 4,
            'and stay bounded - two passes, at most three attempts each, so at most four calls: ' + calls);
        assert.ok(out.mass, 'and a real build comes back');
    });

    it('is bounded: a permanent refusal fails on the third attempt and never loops', async function () {
        let calls = 0;
        const sdk = { async createTransactions() { calls += 1; throw 'Storage mass exceeds maximum'; } };
        await assert.rejects(
            () => buildAndSign({ sdk, entries: oneEntry(), address: 'kaspatest:qpz',
                action: 'SWAP|0|BTC|GIVE|10', privateKey: {}, networkId: 'simnet' }),
            /Storage mass exceeds maximum[\s\S]*attempt 3\/3/,
            'a malformed action must still fail, with the attempt count visible');
        assert.strictEqual(calls, 3, 'exactly three: a bounded retry, not a loop');
    });
});
