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
 *********************************************************************
 *
 * Kaspa transaction builder — the family counterpart of the PSBT path.
 *
 * This is the Kaspa implementation of what adapters/chain_adapter.js declares
 * as buildUnsignedTx(). The action string is chain-agnostic (createAction
 * produces it), so the family only has to carry it in the transaction's
 * `payload` field, sign, and broadcast.
 *
 * The wasm SDK is INJECTED, never required here: this repo's dependency set
 * does not include @kluster/kaspa-wasm, and a builder that reaches for a
 * hardcoded client cannot be driven by the tests or by a different node
 * connector. Pass { sdk } (or let the caller pass its own signer).
 *
 * Measured constraints, each of which cost a live debugging round:
 *
 *   · Fee rule: minimum relay fee = mass x 100 sompi/gram
 *     (rusty-kaspa wallet/core/src/tx/mass.rs:
 *      MINIMUM_RELAY_TRANSACTION_FEE = 100_000 sompi/kg, i.e. 100 sompi/g;
 *      calc_minimum_required_transaction_relay_fee = mass*100000/1000).
 *     P0 measurements: 52 B payload -> fee mass 10,021; 8,192 B -> 18,420.
 *
 *   · The SDK's generator path reports a feeAmount that is TOO LOW to be
 *     relayed: measured 214,000 sompi on a transaction whose mass was 10,021,
 *     which needs 1,002,100. So the fee is computed here from mass and used to
 *     drive priorityFee, in two passes (build with 0, read mass, rebuild).
 *
 *   · payload is capped at MAX_ACTION_DATA_LENGTH, the same ceiling the
 *     protocol layer enforces (xchain-decoder/src/protocol/constants.js:40).
 *     An action string must also be printable ASCII, as on every other chain.
 ********************************************************************/
'use strict';

const crypto = require('crypto');

// -- the obfuscation layer (whitepaper 4.2) ----------------------------------
// "Before embedding, the protocol prepends a 4-byte magic prefix XCHN to the ACTION
//  string and applies AES-128-CTR. The key material derives from the spending
//  transaction's first input txid: the txid is reversed from little-endian to
//  big-endian, then the leading hex forms the key and the following hex forms the IV."
//
// It is obfuscation, not encryption -- the key is public chain data. Its stated purpose is
// to stop naive keyword scanning of the chain and to keep unrelated data from being misread
// as an action. Skipping it (as the Kaspa family first did) leaves cleartext actions on
// chain, and makes us unreadable to any other XChain implementation.
const MAGIC_PREFIX = Buffer.from('XCHN', 'utf8');

function cipherKeyIvFromTxid(txidHex) {
    const bytes = Buffer.from(String(txidHex || '').replace(/^0x/, ''), 'hex');
    if (bytes.length !== 32) {
        throw new Error('obfuscation needs the 32-byte first-input txid, got ' + bytes.length + ' bytes');
    }
    const bigEndian = Buffer.from(bytes).reverse();      // 4.2: LE -> BE
    return { key: bigEndian.slice(0, 16), iv: bigEndian.slice(16, 32) };
}

function obfuscateAction(action, firstInputTxid) {
    const { key, iv } = cipherKeyIvFromTxid(firstInputTxid);
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
    const plain = Buffer.concat([MAGIC_PREFIX, Buffer.from(String(action), 'utf8')]);
    return Buffer.concat([cipher.update(plain), cipher.final()]);
}

// Inverse, for readers. null means the magic prefix was absent (the payload was not
// written by an obfuscating writer), so callers can decide whether to accept it.
function deobfuscateAction(payload, firstInputTxid) {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'hex');
    if (!bytes.length) return null;
    try {
        const { key, iv } = cipherKeyIvFromTxid(firstInputTxid);
        const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
        const plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
        if (!plain.slice(0, 4).equals(MAGIC_PREFIX)) return null;
        return plain.slice(4).toString('utf8');
    } catch (error) {
        return null;
    }
}
const MAX_ACTION_DATA_LENGTH = 8192;

// ── fee rule (pure) ────────────────────────────────────────────────────────
const SOMPI_PER_GRAM = 100n;      // MINIMUM_RELAY_TRANSACTION_FEE = 100_000 sompi/kg

function minimumFeeSompi(mass) {
    const grams = BigInt(mass);
    if (grams <= 0n) throw new Error('mass must be positive');
    return grams * SOMPI_PER_GRAM;
}

// The node's mass estimate can differ from ours by a few grams, so a relayable
// fee carries a margin (default 10%) plus a fixed floor.
function safeFeeSompi(mass, { marginBps = 1000, floor = 1000n } = {}) {
    const minimum = minimumFeeSompi(mass);
    return minimum + (minimum * BigInt(marginBps)) / 10000n + floor;
}

// Throws rather than broadcasting a transaction the mempool will reject.
function assertFeeSufficient(mass, paidSompi) {
    const needed = minimumFeeSompi(mass);
    const paid = BigInt(paidSompi);
    if (paid < needed) {
        throw new Error('fee insufficient: mass=' + mass + ' needs ' + needed + ' sompi, paid ' + paid);
    }
    return true;
}

// ── action string (pure) ───────────────────────────────────────────────────
function assertActionString(action) {
    if (typeof action !== 'string' || action.length === 0) throw new Error('action string is empty');
    if (!action.includes('|')) throw new Error('action string has no | separator');
    const bytes = Buffer.byteLength(action, 'utf8');
    // 4.3 caps the ASSEMBLED payload, not the raw string: the compiled payload is the
    // action plus the 4-byte magic, so an action of exactly the ceiling would overflow it.
    if (bytes + MAGIC_PREFIX.length > MAX_ACTION_DATA_LENGTH) {
        throw new Error('action string too long: ' + bytes + ' bytes + ' + MAGIC_PREFIX.length + ' magic > ' + MAX_ACTION_DATA_LENGTH);
    }
    if (!/^[\x20-\x7e]+$/.test(action)) throw new Error('action string must be printable ASCII (same as the other chains)');
    return { action, bytes };
}

function buildReceipt({ action, txid, mass, fee, network, extra }) {
    return Object.assign({
        ts: new Date().toISOString(),
        chain: 'KASPA',
        network,
        action,
        txid: String(txid),
        mass: String(mass),
        fee: String(fee),
    }, extra || {});
}

// ── build + sign (two passes, fee driven by mass) ──────────────────────────
// entries MUST come from the node (rpc.getUtxosByAddresses). Entries rebuilt
// from REST JSON cannot be signed: the shape is not the one the signer expects.
async function buildAndSign({
    sdk, entries, address, action, privateKey, networkId = 'testnet-10',
    spendKeepSompi = 100000000n,        // leave change rather than a dust output
}) {
    if (!sdk || typeof sdk.createTransactions !== 'function') throw new Error('buildAndSign needs the wasm sdk (createTransactions)');
    if (!entries || !entries.length) throw new Error('buildAndSign needs at least one UTXO entry');
    const { bytes } = assertActionString(action);

    // 4.2: the payload carries the OBFUSCATED action, keyed on the first input's txid.
    const firstInputTxid = entries[0].outpoint && entries[0].outpoint.transactionId;
    const payload = obfuscateAction(action, firstInputTxid);
    const total = entries.reduce((sum, e) => sum + BigInt(e.amount), 0n);
    // The SDK takes the output amount as a JS number, so a total beyond 2^53-1 sompi
    // cannot be represented exactly. Refuse instead of rounding a coin amount.
    const MAX_EXACT_SOMPI = 9007199254740991n;
    if (total > MAX_EXACT_SOMPI) {
        throw new Error('buildAndSign: entry total ' + total + ' sompi exceeds the exact-integer range of the SDK; split the inputs');
    }
    const outputAmount = Number(total - BigInt(spendKeepSompi));
    if (!(outputAmount > 0)) throw new Error('entries do not cover the spend: ' + total + ' sompi');

    // The wasm SDK throws BARE STRINGS for its own limits ("Storage mass exceeds maximum", measured
    // on testnet-10 with an 8000-byte payload over 2 UTXOs). Our callers log error.message, so that
    // refusal arrived as the word "undefined" - a money-class failure delivered as nothing at all.
    const SDK_ATTEMPTS = 3;
    const callSdk = async (options) => {
        let lastError = null;
        for (let attempt = 1; attempt <= SDK_ATTEMPTS; attempt += 1) {
            try {
                return await sdk.createTransactions(options);
            } catch (error) {
                lastError = error;
                const text = error && error.message ? error.message : String(error);
                // Measured on testnet-10: the SAME valid action over the SAME UTXOs was refused once
                // and then built fine minutes later ("Storage mass exceeds maximum"), while a
                // malformed action was refused ten times out of ten. So this one message can be
                // either transient or a real refusal, and a bounded retry is the only way to tell
                // them apart - a bad action still fails on the last attempt, with the same message.
                // Safety: this runs before signing or broadcasting anything, so a retry cannot
                // double-spend or double-publish.
                if (!/storage mass|mass exceeds/i.test(text) || attempt === SDK_ATTEMPTS) {
                    const parts = String(action).split('|');
                    const shape = parts[0] + ' v' + parts[1] + ', ' + parts.length + ' field(s)';
                    throw new Error('buildAndSign: ' + text + ' [action ' + shape + ', attempt ' + attempt +
                        '/' + SDK_ATTEMPTS + ' - if the SDK text names a weight or mass limit, check the ' +
                        'action against the documented wire format for that action and version first]');
                }
            }
        }
        throw lastError;
    };

    const buildOptions = (priorityFee) => ({
        entries,
        outputs: [{ address, amount: outputAmount }],
        changeAddress: address,
        priorityFee,
        networkId,
        payload,
    });

    // Pass 1: get the mass the node will charge for. Pass 2: rebuild with a fee
    // derived from it. Never trust the SDK's feeAmount (see the header).
    let built = await callSdk(buildOptions(0n));
    const massProbe = BigInt((built.transactions[0] && built.transactions[0].mass) || 0n);
    built = await callSdk(buildOptions(massProbe > 0n ? safeFeeSompi(massProbe) : 5000000n));

    const pending = built.transactions[0];
    const mass = BigInt(pending.mass || 0n) || massProbe || 1n;
    await pending.sign([privateKey]);

    const transaction = pending.transaction;
    const inSum = entries.reduce((sum, e) => sum + BigInt(e.amount), 0n);
    const outSum = transaction.outputs.reduce((sum, o) => sum + BigInt(o.value), 0n);
    const paidFee = inSum - outSum;
    // Self-check against what was actually embedded, not against what was asked
    // for: a fee that silently ends up below the relay minimum is the exact
    // failure this module exists to prevent.
    assertFeeSufficient(mass, paidFee);
    // M1/M2, found by the money review: the check above is a LOWER bound only, so a build whose
    // change never came back passed it and was returned as a receipt. Two things are asserted now,
    // both derived from the signed transaction: the fee must not be fat, and when a change is
    // expected there must be an output to carry it. WHICH address that output pays is the caller's
    // contract - this module cannot see the recipient through the SDK's output shape, and saying so
    // is the honest boundary rather than implying a guarantee it cannot make.
    // Refusing here, after sign(), is deliberate: the caller has a transaction object it must not
    // broadcast, and losing the build is the cheap outcome next to a lost coin.
    const fairFee = safeFeeSompi(mass);
    if (paidFee > fairFee * 10n) {
        throw new Error('buildAndSign: effective fee ' + paidFee + ' sompi is far above the mass-derived '
            + fairFee + ' sompi; the change did not come back to the sender (refusing to sign)');
    }
    const expectedChange = inSum - BigInt(outputAmount) - fairFee;
    if (expectedChange > 100000n && transaction.outputs.length < 2) {
        throw new Error('buildAndSign: about ' + expectedChange + ' sompi of change was expected but the '
            + 'transaction carries a single output; the remainder would become fee (refusing to sign)');
    }

    return { transaction, txid: String(transaction.id), mass, paidFee, payloadBytes: bytes, payloadHex: Buffer.from(payload).toString('hex') };
}

// ── read-back verification (payload must round-trip byte for byte) ─────────
function payloadHexOf(wirePayload) {
    if (wirePayload === null || wirePayload === undefined) return null;
    if (typeof wirePayload === 'string') return wirePayload.replace(/^0x/, '').toLowerCase();
    return Buffer.from(wirePayload).toString('hex');
}

module.exports = {
    MAX_ACTION_DATA_LENGTH,
    SOMPI_PER_GRAM,
    minimumFeeSompi,
    safeFeeSompi,
    assertFeeSufficient,
    assertActionString,
    buildReceipt,
    buildAndSign,
    payloadHexOf,
    obfuscateAction,
    deobfuscateAction,
    cipherKeyIvFromTxid,
};
