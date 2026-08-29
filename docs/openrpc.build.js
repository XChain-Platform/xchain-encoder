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
        name: 'health',
        summary: 'Probe hard dependencies (UTXO tracker) and report reachability and sync state.',
        description: 'Unlike ping, a health failure means the encoder cannot serve requests correctly. '
            + 'When the tracker is unreachable the fields stay at their defaults (false / null).',
        params: [],
        result: { name: 'health', schema: { type: 'object', properties: { tracker_reachable: bool('UTXO tracker reachable'), tracker_synced: bool('tracker is serveable: synced, inside our lag bounds on both sides, not halted, and mempool-reconverged'), tracker_lag: { type: ['integer', 'null'], description: 'tracker block lag, or null when unknown/unreachable; negative means the tracker is ahead of the node' }, tracker_halted: bool('tracker stopped polling on an unrecoverable reorg'), tracker_mempool_ready: bool('tracker has reconverged its mempool, so an already-spent confirmed output can be filtered out') } } },
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
            + 'Dogecoin has no segwit: P2WSH and TAPROOT encodings are rejected on DOGE networks. '
            + 'encoding:"TAPROOT" (BTC/LTC, explicit only) is a single-call two-transaction flow: the result '
            + 'carries the commit PSBT (psbt), the pre-built reveal PSBT (revealPsbt) and an `envelope` recovery '
            + 'record ({commitTxid, commitVout, commitValue, commitAddress, internalPubkey, tapleafHash, '
            + 'controlBlock, revealFee}) that the wallet must persist durably BEFORE broadcasting the commit; '
            + 'sign both, broadcast commit then reveal. TAPROOT requires compressedPubKey (the envelope internal '
            + 'key), segwit-only inputs, and accepts payloads up to the 400,000-byte envelope ceiling.',
        params: [
            { name: 'pubkey', required: true, schema: str('sender address (or public key for compressed flows)') },
            { name: 'data', schema: str('ACTION payload string (pipe-delimited, from xchain-sdk createAction)') },
            { name: 'rawData', schema: str('additional raw bytes, Latin-1 decoded (gated-FILE ciphertext, ECIES envelopes)') },
            { name: 'utxos', schema: { type: 'array', description: 'explicit UTXOs; fetched from the UTXO tracker when omitted (max 500)', items: { type: 'object' } } },
            { name: 'customOutputs', schema: { type: 'array', description: 'extra outputs [{address, value}] (max 100); value is base units, pass amounts above 2^53-1 as an exact decimal string', items: { type: 'object' } } },
            { name: 'feeQuote', schema: { type: 'object', description: 'protocol fee output {address, amount} from the hub/indexer fee quote' } },
            { name: 'fee', schema: int('absolute fee in base units (rejected if over the fee-rate cap)') },
            { name: 'feePerKb', schema: int('fee rate in base units per kB (clamped to the fee-rate cap)') },
            { name: 'dust', schema: int('dust threshold override') },
            { name: 'rbf', schema: bool('signal replace-by-fee') },
            { name: 'unconfirmed', schema: bool('allow spending unconfirmed UTXOs') },
            { name: 'encoding', schema: str('force a carrier, or "AUTO" to let the encoder pick the smallest-footprint one this network and signer support (OP_RETURN for payloads that fit one output, else TAPROOT where available, else P2WSH, else P2SH). AUTO is an OPT-IN because it can resolve to TAPROOT, which returns a commit/reveal PAIR instead of one PSBT. Omitting encoding keeps the legacy behaviour (OP_RETURN, else P2SH) unchanged.', { enum: ['OP_RETURN', 'MULTISIGN', 'P2SH', 'P2WSH', 'TAPROOT', 'AUTO'] }) },
            { name: 'change', schema: str('change address (defaults to sender)') },
            { name: 'p2shHash', schema: str('funding txid: switches to the P2SH/P2WSH reveal (tx2) flow') },
            { name: 'p2shHex', schema: str('funding tx raw hex (required with p2shHash)') },
            { name: 'compressedPubKey', schema: str('compressed public key when pubkey is an address') },
            { name: 'compress', schema: bool('transparent FILE payload compression (deflate-raw, kept only when it is smaller and within the 150:1 guard), which appends the COMPRESSION field to a FILE v0 ACTION string. ON BY DEFAULT: omit this to take the deployment default, pass false to opt out. An EXPLICIT true that cannot be honoured is an error (a non-FILE action has nowhere to record the marker; a token-gated FILE\'s COMPRESSION means inflate-after-decrypt and belongs to the client that compressed before encrypting; an action that already declares a codec is never re-compressed). The default pass simply rides raw in those cases and says why in the result.') },
            { name: 'attachPrevTx', schema: bool('attach each segwit input\'s FULL previous transaction alongside its witnessUtxo; default off. Only a hardware signer needs it: a Ledger derives the outpoint it signs from the prev tx it is handed, so a witnessUtxo-only input cannot be signed on the device. Off by default because it costs one node round trip per input plus the prev tx bytes in every copy of the PSBT.') },
            { name: 'options', schema: { type: 'object', description: 'per-call capabilities. signerSupportsTapscript (boolean, default false) tells AUTO whether this caller can sign a tapscript script-path spend; without it AUTO never selects TAPROOT, because the reveal must be signable before the commit is broadcast. Unknown keys are refused.' } },
        ],
        result: { name: 'tx', schema: { type: 'object', properties: { psbt: str('unsigned PSBT, hex (the commit PSBT for TAPROOT)'), encoding: str('encoding actually used (the resolved carrier when AUTO was requested)'), compression: { type: 'object', description: 'present whenever compression ran: {compressed, rawLength, storedLength, reason}. reason names why a payload rode raw (not-a-file-action, gated-file, codec-already-declared, not-smaller, ratio-guard, over-input-cap, deflate-failed).' }, revealPsbt: str('TAPROOT only: pre-built reveal PSBT, hex'), envelope: { type: 'object', description: 'TAPROOT only: recovery record to persist before broadcasting the commit' }, carrierScripts: { type: 'array', description: 'P2SH/P2WSH/TAPROOT: carrier scripts (hex) for verify-before-sign', items: { type: 'string' } }, warnings: { type: 'array', description: 'present only when the built transaction carries a caveat the caller should see before signing; each entry is {code, message}. RAWDATA_ONLY_NOT_DECODED: rawData sent without data compiles to an OP_0-led payload that current decoders read as empty, so the transaction confirms and the fee is paid but the payload is not indexed as an ACTION.', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } } } },
    },
    {
        name: 'create_envelope_cancel_tx',
        summary: 'Build the key-path cancel PSBT sweeping an unrevealed TAPROOT envelope commit back to the caller.',
        description: 'Rebuilds the sweep from the persisted recovery record alone; the PSBT carries '
            + 'tapInternalKey and tapMerkleRoot so the signer can compute the BIP341 tweak. The cancel conflicts '
            + 'with the reveal by construction (same outpoint): treat it as a replacement of the reveal.',
        params: [
            { name: 'commitTxid', required: true, schema: str('commit transaction id (64-char hex)') },
            { name: 'commitVout', required: true, schema: int('commit output index') },
            { name: 'commitValue', required: true, schema: int('commit output value in base units') },
            { name: 'internalPubkey', required: true, schema: str('envelope internal key: 66-char compressed or 64-char x-only hex') },
            { name: 'tapleafHash', required: true, schema: str('BIP341 tapleaf hash of the envelope script (64-char hex); the single-leaf merkle root') },
            { name: 'destination', required: true, schema: str('address to sweep the commit value to') },
            { name: 'feePerKb', schema: int('fee rate in base units per kB (clamped to the fee-rate cap)') },
            { name: 'replacebyfee', schema: bool('signal replace-by-fee') },
        ],
        result: { name: 'cancel', schema: { type: 'object', properties: { psbt: str('unsigned key-path sweep PSBT, hex'), encoding: str('"TAPROOT"'), cancel: bool('always true'), fee: int('miner fee funded, base units') } } },
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
            + 'XChain ACTION payloads into BTC/LTC/DOGE transactions. One instance per chain. The public '
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

// Writing is the SCRIPT's job, not the module's, so a test can require this file
// for the spec it would emit and compare it against the checked-in artifact
// without rewriting that artifact mid-run (see test/unit/openrpc-coverage.test.js).
if (require.main === module) {
    const out = path.join(__dirname, 'openrpc.json');
    fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
    console.log(`wrote ${out}: ${spec.methods.length} methods`);
}

module.exports = { spec, METHODS };
