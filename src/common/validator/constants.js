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
 * XChain Encoder - Input Validator
 *
 * Centralized validation for all createTransaction parameters.
 * Every function throws TypeError or RangeError on invalid input,
 * or returns the (possibly coerced) valid value.
 *
 ********************************************************************/

// Maximum *compiled* on-chain ACTION push, in bytes. Must equal the decoder's
// MAX_ACTION_DATA_LENGTH: a transaction whose compiled push exceeds this is
// silently dropped by every indexing node. Canonical source of truth:
// xchain-documentation/protocol/constants.js (MAX_ACTION_DATA_LENGTH). The
// cross-service regression suite asserts these stay equal.
const MAX_COMPILED_ACTION_DATA_LENGTH = 8192
// Length prefix a single OP_PUSHDATA2 push prepends to a >=256-byte payload
// (1 opcode + 2 length bytes). The widest single raw push is measured against
// the compiled ceiling with this prefix included. Canonical source of truth:
// xchain-documentation/protocol/constants.js (OP_RETURN_PUSH_OVERHEAD). The
// cross-service regression suite pins this local copy by name against that
// declaration, so the name must match exactly, not just the value.
const OP_RETURN_PUSH_OVERHEAD = 3
// Explicit-encoding OP_RETURN ceiling: a single nulldata output is 80 bytes, of
// which the 4-byte "XCHN" magic word is reserved, leaving 76 bytes of compiled
// payload. Mirrors XChainEncoder.prepareData (OP_RETURN_SIZE - MAGIC_WORD length),
// which stays the arbiter/backstop; measured pre-compile here only when the caller
// explicitly requests encoding:"OP_RETURN" so an oversize request is rejected as
// -32602 invalid-params before any UTXO reservation, instead of failing post-compile
// as a -32603 internal error. The compiled value this is compared against is
// exactly finalDataBuffer.length in createTransaction (same compiledPushSize sum).
const OP_RETURN_OUTPUT_SIZE = 80
const OP_RETURN_MAGIC_WORD_LENGTH = 4
const MAX_OP_RETURN_COMPILED_LENGTH = OP_RETURN_OUTPUT_SIZE - OP_RETURN_MAGIC_WORD_LENGTH  // 76
// Taproot-envelope payload ceiling, per-encoding by design:
// only encoding:"TAPROOT" gets it, every legacy encoding keeps the 8,192-byte
// compiled ceiling (a global raise would multiply the chunked-carrier abuse ceiling
// ~50x for no benefit). Measures the reassembled envelope payload byte length
// after concatenation of the payload pushes, which is byte-identical to the
// compiled action stream (finalDataBuffer) the shipped carriers contain; the
// envelope's own 520-byte push framing is NOT counted.
// DERIVED FROM WEIGHT: the binding limit is Bitcoin Core's
// MAX_STANDARD_TX_WEIGHT of 400,000 WU, not a round byte count. 400,000 payload
// bytes build a 402,789 WU reveal, which is non-standard and unrelayable; the
// true maxima are 397,228 (P2WPKH change) and 397,009 (P2TR change + floor pad).
// 390,000 sits 7,050 WU under the limit in the worst reveal shape. Re-derive it
// from the weight limit if it ever changes; do not pick a number.
const ENVELOPE_MAX_PAYLOAD = 390_000
const MAX_UTXO_COUNT = 500
const MAX_CUSTOM_OUTPUTS = 100
// Sanity ceiling on the fee/dust/feeQuote money fields: 21,000 BTC in satoshis.
// This is deliberately far tighter than the 21M-BTC supply, and the value is the
// contract, not a rounding of it. Do NOT "repair" it to 2_100_000_000_000_000 to
// chase a supply figure: that loosens every fee-path ceiling 1000x. Large output
// amounts do not route here; they go through parseSatoshiAmount's u64 ceiling.
const MAX_FEE_SATOSHIS = 2_100_000_000_000
// Maximum accepted raw-transaction hex length, in characters. A standard
// BTC/LTC/DOGE transaction tops out around 100 KB (200,000 hex chars), so
// 400,000 chars (a 200 KB transaction) is comfortably above anything the
// platform constructs while still shedding megabyte garbage before it reaches
// Transaction.fromHex / Buffer.from or a coin-node round-trip. The Express
// 1 MB body limit is the outer bound either way; this gives a precise, named
// rejection instead of a node-side parse error.
const MAX_RAW_TX_HEX_LENGTH = 400_000
// broadcast_tx ceiling, wider than MAX_RAW_TX_HEX_LENGTH on purpose: a signed
// Taproot-envelope reveal carries up to ENVELOPE_MAX_PAYLOAD payload bytes in
// its witness, so the whole transaction runs to ~405 KB (~810,000 hex chars),
// which the old 400,000-char cap would refuse at the last step of the flow.
// 1,000,000 chars (a 500 KB transaction) clears the largest legal reveal with
// headroom while still shedding megabyte garbage. p2shHex deliberately keeps
// the tighter cap: chunked funding transactions never approach it.
const MAX_BROADCAST_TX_HEX_LENGTH = 1_000_000
const RAW_TX_HEX_RE = /^(?:[0-9a-fA-F]{2})+$/
// Maximum accepted utxos[].scriptPubKey hex length, in characters. Bitcoin's
// consensus MAX_SCRIPT_SIZE is 10,000 bytes, so 20,000 hex chars is the widest
// a legitimate output script can be; anything larger is garbage and is rejected
// before it reaches Buffer.from(...,'hex') / bitcoin.script.decompile.
const MAX_SCRIPTPUBKEY_HEX_LENGTH = 20_000
// AUTO is not a carrier: it is the caller's explicit request that the encoder
// pick the smallest-footprint carrier the network and signer support. It
// resolves to one of the others before anything is built. It is an
// OPT-IN precisely because resolving to TAPROOT changes the response shape from
// one PSBT to a commit/reveal pair, which no existing caller expects.
const VALID_ENCODINGS = new Set(['OP_RETURN', 'P2SH', 'MULTISIGN', 'P2WSH', 'TAPROOT', 'AUTO'])
const HEX_64_RE = /^[0-9a-fA-F]{64}$/
const COMPRESSED_PUBKEY_RE = /^(02|03)[0-9a-fA-F]{64}$/

// Canonical ACTION names the decoder accepts (xchain-decoder VALID_ACTION_NAMES,
// XChainDecoder.js). Vendored here byte-for-byte from
// xchain-documentation/protocol/action-manifest.json (wireDecoded slice), the
// same source xchain-decoder/test/fixtures/action-manifest.json vendors from.
// The decoder is the arbiter of which leading ACTION token survives
// decode (both the confirmed-block and mempool gates reject anything not in
// this set, after alias expansion, silently no-actioning the tx); the encoder
// had no equivalent gate, so a typoed or too-new ACTION name would encode, pay
// fees, and broadcast, then vanish silently at decode. Pinned against drift by
// test/unit/common/validator/action_manifest_conformance.test.js, mirroring the decoder's own
// conformance guard.
const VALID_ACTION_NAMES = new Set([
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST',
    'BATCH', 'BET', 'BROADCAST', 'CALLBACK', 'COINPAY', 'COLLECT',
    'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'NODEPROOF', 'ORDER', 'PRICE', 'ROLLCALL', 'SEND', 'SLASH', 'SLEEP', 'STAKE',
    'SWAP',
    'SWEEP', 'UNSTAKE', 'VOTE', 'WITHDRAW',
    // Bridge lock/burn. Mirrors the decoder set: the user-broadcast versions (0, 1, 3, 4)
    // must clear this gate to reach a decoder at all, and the mirror-injected settle legs
    // (2, 5) are never encoded here because no user may author one.
    'XBRIDGE'
])

// Short-form ACTION-name aliases, expanded to canonical form before the
// VALID_ACTION_NAMES gate. Must stay identical to xchain-decoder's
// ACTION_ALIASES (XChainDecoder.js): the decoder is what actually expands
// these on-chain, so the encoder's pre-check has to agree with it exactly or
// it will reject an alias the decoder would have accepted, or (worse) accept a
// typo the decoder does not recognize as an alias.
const ACTION_ALIASES = {
    'TRANSFER': 'SEND',
    'ADDR': 'ADDRESS',
    'DROP': 'AIRDROP',
    'CAST': 'BROADCAST',
    'MSG': 'MESSAGE'
}
// Wire-format ceiling for a satoshi amount: the transaction output value
// field is an unsigned 64-bit integer, so 2^64-1 is the largest amount any
// coin can carry in one output regardless of supply policy.
const MAX_SATOSHI_U64 = 0xffffffffffffffffn
// The create_tx options bag. Unknown keys are refused rather than ignored: a
// misspelled capability that silently means "no" would send an envelope-capable
// signer down the P2WSH path at 2x the cost with no signal, and a misspelled one
// that silently meant "yes" would be worse.
const VALID_CREATE_TX_OPTIONS = new Set(['signerSupportsTapscript', 'exactInputs'])

module.exports = {
    MAX_COMPILED_ACTION_DATA_LENGTH,
    OP_RETURN_PUSH_OVERHEAD,
    OP_RETURN_OUTPUT_SIZE,
    OP_RETURN_MAGIC_WORD_LENGTH,
    MAX_OP_RETURN_COMPILED_LENGTH,
    ENVELOPE_MAX_PAYLOAD,
    MAX_UTXO_COUNT,
    MAX_CUSTOM_OUTPUTS,
    MAX_FEE_SATOSHIS,
    MAX_RAW_TX_HEX_LENGTH,
    MAX_BROADCAST_TX_HEX_LENGTH,
    RAW_TX_HEX_RE,
    MAX_SCRIPTPUBKEY_HEX_LENGTH,
    VALID_ENCODINGS,
    HEX_64_RE,
    COMPRESSED_PUBKEY_RE,
    VALID_ACTION_NAMES,
    ACTION_ALIASES,
    MAX_SATOSHI_U64,
    VALID_CREATE_TX_OPTIONS
}
