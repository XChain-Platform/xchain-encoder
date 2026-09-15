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
 * XChain Encoder - Encoder Class
 * 
 * This file handles starting the encoder and generating transactions
 * 
 ********************************************************************/

const { getLogger } = require('../observability');

const logger = getLogger();

const OP_RETURN_SIZE = 80
const P2SH_SIZE = 520
// Each data chunk is pushed as a SINGLE script element inside the witness
// script, so it is bound by consensus MAX_SCRIPT_ELEMENT_SIZE (520 bytes),
// the same limit that caps the P2SH chunk. It is NOT bound by the 3600-byte
// total witness-script policy limit. A larger chunk (e.g. the former 3571)
// builds a witness script the node rejects at spend time with "Push value
// size limit exceeded". 520 - 44 overhead = 476-byte max chunk, identical to P2SH.
const PW2SH_SIZE = 520
const MULTISIGN_SIZE = 69 // 9 bytes overhead (1 OP_CHECKMULTISIG + 1 m + 1 n + 2 key-length bytes + 4 magic) + 60 raw data bytes = 69 total bytes per chunk
const MAGIC_WORD = "XCHN"

// Taproot envelope: the payload rides as 520-byte pushes inside
// a single tapscript leaf, bounded per element by consensus
// MAX_SCRIPT_ELEMENT_SIZE exactly like the chunk lanes; tapscript has no
// 10,000-byte script cap, so ONE leaf carries the whole payload.
const TAPROOT_ENVELOPE_CHUNK_SIZE = 520
// BIP342 tapscript leaf version. Also the first control-block byte (even
// output-key parity keeps it 0xc0 verbatim).
const TAPROOT_LEAF_VERSION = 0xc0
// Envelope format byte 0x00 = this version. Any other value is unrecognized
// by design (invisible, not invalid): future formats activate via their own
// recognition flag heights.
const TAPROOT_ENVELOPE_FORMAT_V0 = 0x00

const SATOSHI_UNIT = 100000000

const MAX_SAFE_SATOSHI_BIG = BigInt(Number.MAX_SAFE_INTEGER)

// Relay-policy floor per coin for every value output this encoder authors, distinct
// from the consensus-pinned network.dustThreshold the decoder reads. Dogecoin relays an
// output under its 0.01 DOGE soft dust limit only if the whole limit is added to the fee.
const SOFT_DUST_FLOOR_BY_COIN = {
    DOGE: 1000000
}

// Ceiling on the SUGGESTED fee rate (base units per vByte) for a caller that
// supplies none, applied on test chains only. estimatesmartfee needs a populated
// fee market to mean anything; a quiet test chain returns a large fallback at
// every confirmation target, which prices an ordinary action above the balance
// funding it and fails the build outright. Mainnet is deliberately unclamped:
// there the estimate is real and a ceiling would underpay a genuine fee spike.
// This bounds only the rate CHOSEN on the caller's behalf, never a rate the
// caller supplied and never the anchor the fee-drain caps derive from.
const DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE = 20

// Test chains by network key suffix; everything else is treated as mainnet.
const TEST_NETWORK_SUFFIXES = ['-testnet', '-testnet4', '-regtest', '-signet']

// The ceiling above is denominated in base units per vByte, and 20 is a
// Bitcoin-scale number: on Dogecoin the node's relay floor is already 100
// koinu/byte (0.001 DOGE/kB) and 1.14 rejects anything at or under the floor
// through its free-transaction priority gate ("66: insufficient priority"),
// so a ceiling of 20 turns every clamped build into a guaranteed rejection.
// Lift the ceiling to a coin-correct minimum derived from the node's own
// relayfee (BTC-or-coin per kB): ten times the floor, Dogecoin's published
// recommended rate (0.01 DOGE/kB) and 10 sat/vB on BTC/LTC test chains.
const SUGGESTED_FEE_CEILING_RELAY_MULTIPLIER = 10

// Hard ceiling (base units) on what CPFP package sizing may ADD to one
// transaction's fee, on top of every rate cap the build already enforces. The
// rate caps bound a fee against THIS transaction's size; a package uplift is
// paid for someone else's bytes, so a mempool ancestor chain that is large,
// cheap, or misreported could otherwise buy an arbitrarily large fee with the
// caller's coin. 10,000,000 base units is 0.1 DOGE (ten times the block-
// inclusion floor for a 10 kB package, so it clears any realistic real chain)
// and stays well inside the rate caps on BTC/LTC, where they bind first anyway.
// MAX_CPFP_UPLIFT_SAT overrides it; 0 turns package sizing off.
const DEFAULT_MAX_CPFP_UPLIFT_SAT = 10000000

// How long a selected outpoint stays reserved against concurrent selection.
// Long enough for a caller to sign and broadcast, short enough that an
// abandoned selection auto-releases without operator intervention. In-memory
// and best-effort only (the encoder is a single stateless process): this
// narrows, but cannot fully close, a same-address double-spend race. See the
// reservation helpers and the selection loop.
const RESERVATION_TTL_MS = 5 * 60 * 1000

const Encoding = {
    OP_RETURN: "OP_RETURN",
    P2SH: "P2SH",
    MULTISIGN: "MULTISIGN",
    P2WSH: "P2WSH",
    TAPROOT: "TAPROOT",
    // Not a carrier: the caller's explicit request that the encoder pick the
    // smallest-footprint carrier this network and signer can actually use.
    // Resolved to one of the above before anything is built,
    // so no downstream code ever sees it.
    AUTO: "AUTO"
}

module.exports = { logger, OP_RETURN_SIZE, P2SH_SIZE, PW2SH_SIZE, MULTISIGN_SIZE, MAGIC_WORD, TAPROOT_ENVELOPE_CHUNK_SIZE, TAPROOT_LEAF_VERSION, TAPROOT_ENVELOPE_FORMAT_V0, SATOSHI_UNIT, MAX_SAFE_SATOSHI_BIG, SOFT_DUST_FLOOR_BY_COIN, DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE, TEST_NETWORK_SUFFIXES, SUGGESTED_FEE_CEILING_RELAY_MULTIPLIER, DEFAULT_MAX_CPFP_UPLIFT_SAT, RESERVATION_TTL_MS, Encoding }
