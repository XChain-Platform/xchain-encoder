#!/usr/bin/env node
/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available - contact legal@dankest.llc.
 *
 * Generates docs/openrpc.json (OpenRPC 1.3.2) for the encoder's JSON-RPC API.
 * METHODS below mirrors the jsonRpcController in src/api.js; the unit test
 * test/unit/openrpc-coverage.test.js fails if the two drift apart.
 *
 * Run: node docs/openrpc.build.js
 */
const fs = require('fs');
const path = require('path');

const str = (description, extra) => Object.assign({ type: 'string', description }, extra);
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

const METHODS = [
    {
        name: 'ping',
        summary: 'Health check; reports the running encoder version.',
        params: [],
        result: { name: 'pong', schema: { type: 'object', properties: { status: str('"success"'), version: str('encoder semver') } } },
    },
    {
        name: 'estimate_fee',
        summary: 'Suggested fee tiers in base-units per vByte (sat/koinu/litoshi) from the node\'s estimatesmartfee.',
        params: [],
        result: { name: 'tiers', schema: { type: 'object', properties: { low: int('6-block target'), medium: int('3-block target'), high: int('next-block target') } } },
    },
    {
        name: 'create_tx',
        summary: 'Build an unsigned PSBT embedding an XChain ACTION payload. The caller signs and broadcasts.',
        description: 'Encoding auto-selects OP_RETURN for payloads ≤76 bytes, else P2SH (two-transaction flow: '
            + 'call once for the funding tx, then again with p2shHash/p2shHex to build the reveal tx). '
            + 'rawData is decoded as Latin-1 so arbitrary bytes round-trip losslessly. '
            + 'Dogecoin has no segwit: P2WSH encoding is rejected on DOGE networks.',
        params: [
            { name: 'pubkey', required: true, schema: str('sender address (or public key for compressed flows)') },
            { name: 'data', schema: str('ACTION payload string (pipe-delimited, from xchain-sdk createAction)') },
            { name: 'rawData', schema: str('additional raw bytes, Latin-1 decoded (gated-FILE ciphertext, ECIES envelopes)') },
            { name: 'utxos', schema: { type: 'array', description: 'explicit UTXOs; fetched from the UTXO tracker when omitted (max 500)', items: { type: 'object' } } },
            { name: 'customOutputs', schema: { type: 'array', description: 'extra outputs [{address, value}] (max 100)', items: { type: 'object' } } },
            { name: 'feeQuote', schema: { type: 'object', description: 'protocol fee output {address, amount} from the hub/indexer fee quote' } },
            { name: 'fee', schema: int('absolute fee in base units (rejected if over the fee-rate cap)') },
            { name: 'feePerKb', schema: int('fee rate in base units per kB (clamped to the fee-rate cap)') },
            { name: 'dust', schema: int('dust threshold override') },
            { name: 'rbf', schema: bool('signal replace-by-fee') },
            { name: 'unconfirmed', schema: bool('allow spending unconfirmed UTXOs') },
            { name: 'encoding', schema: str('force encoding', { enum: ['OP_RETURN', 'MULTISIGN', 'P2SH', 'P2WSH'] }) },
            { name: 'change', schema: str('change address (defaults to sender)') },
            { name: 'p2shHash', schema: str('funding txid — switches to the P2SH/P2WSH reveal (tx2) flow') },
            { name: 'p2shHex', schema: str('funding tx raw hex (required with p2shHash)') },
            { name: 'compressedPubKey', schema: str('compressed public key when pubkey is an address') },
        ],
        result: { name: 'tx', schema: { type: 'object', properties: { psbt: str('unsigned PSBT, hex'), encoding: str('encoding actually used') } } },
    },
    {
        name: 'broadcast_tx',
        summary: 'Broadcast a signed raw transaction to the coin node.',
        params: [{ name: 'tx_hex', required: true, schema: str('signed raw transaction hex') }],
        result: { name: 'broadcast', schema: { type: 'object', properties: { txid: str('transaction id') } } },
    },
    {
        name: 'get_utxos',
        summary: 'List UTXOs for an address (proxied from xchain-utxo-tracker).',
        params: [{ name: 'address', required: true, schema: str('address to query') }],
        result: { name: 'utxos', schema: { type: 'array', items: { type: 'object' } } },
    },
];

const spec = {
    openrpc: '1.3.2',
    info: {
        title: 'XChain Encoder API',
        version: '1.0.0',
        description: 'Stateless JSON-RPC 2.0 service (POST /) that builds unsigned PSBTs embedding '
            + 'XChain ACTION payloads into BTC/LTC/DOGE transactions. One instance per chain — the public '
            + 'deployment is path-routed per coin: https://encoder.xchain.io/{COIN}/ (COIN = BTC/TBTC, '
            + 'LTC/TLTC, DOGE/TDOGE). Auth is optional: when the operator configures an API key, requests '
            + 'need an x-api-key header; the public instances run open. Errors follow JSON-RPC 2.0 '
            + '({code, message}): -32602 invalid params, -32603 internal, -32001 unauthorized, -32029 rate '
            + 'limited. See the registry at https://docs.xchain.io/protocol/Error_Codes.md. '
            + 'LLM-friendly docs: https://docs.xchain.io/llms.txt',
        license: { name: 'AGPL-3.0-or-later', url: 'https://docs.xchain.io/legal/LICENSING.md' },
    },
    servers: [{ name: 'public', url: 'https://encoder.xchain.io/{COIN}/', variables: { COIN: { default: 'BTC', enum: ['BTC', 'TBTC', 'LTC', 'TLTC', 'DOGE', 'TDOGE'] } } }],
    methods: METHODS.map((m) => ({
        name: m.name,
        summary: m.summary,
        description: m.description,
        paramStructure: 'by-name',
        params: (m.params || []).map((p) => ({ name: p.name, required: !!p.required, schema: p.schema })),
        result: m.result,
    })),
};

const out = path.join(__dirname, 'openrpc.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out}: ${spec.methods.length} methods`);
