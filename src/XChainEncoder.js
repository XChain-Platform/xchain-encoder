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

// Must load before any PSBT is built: teaches bitcoinjs-lib/bip174 to carry
// satoshi values above 2^53-1 as BigInt (DOGE has no supply cap).
require('./applyBufferutilsPatch')
const bitcoin = require('bitcoinjs-lib');
const crypto = require('crypto');
const bs58check = require('bs58check')
const BlockchainConnector = require('./BlockchainConnector')
const CryptoNetworks = require('./CryptoNetworks')
const UtxoTracker = require('./UtxoTracker')
const TxSizeEstimator = require("./TxSizeEstimator")
const { MAX_COMPILED_ACTION_DATA_LENGTH, ENVELOPE_MAX_PAYLOAD, MAX_UTXO_COUNT, validateUtxoEntry, parseSatoshiAmount, validateFeePerKb, validateOptionalBoolean, validateAddress } = require('./validator')
const { compressPayloadForAction } = require('./compression')
const { OperationalError } = require('./errors')
const { upstreamErrorMessage } = require('./errorSanitize')

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

// Byte width of the compactSize varint that prefixes a length on the wire.
// Distinct from compiledPushSize: that models bitcoin.script.compile's PUSH
// OPCODE framing (direct push / OP_PUSHDATA1 / OP_PUSHDATA2) and is correct
// only INSIDE a script. Witness-stack items are not script pushes; each is
// framed by a compactSize varint, which switches width at 253, not at 76/256.
function compactSizeLen(n) {
    if (n < 253) return 1
    if (n <= 0xffff) return 3
    if (n <= 0xffffffff) return 5
    return 9
}

// Serialized compactSize varint for `n`, the wire form whose width
// compactSizeLen models. Needed for the BIP341 tapleaf hash, whose preimage
// length-prefixes the script with a compactSize (not a script push).
function compactSizeBuffer(n) {
    if (n < 253) return Buffer.from([n])
    if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b }
    const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b
}

// BIP341 tapleaf hash of the envelope script:
// taggedHash("TapLeaf", leaf_version || compactSize(len(script)) || script).
// For the single-leaf envelope tree this doubles as the taproot merkle root,
// which is exactly the third element of the wallet's cancel-recovery record
// {commit outpoint, internal key derivation path, tapleaf hash}: the key-path
// tweak cannot be reconstructed without it.
function envelopeTapLeafHash(script) {
    return bitcoin.crypto.taggedHash('TapLeaf',
        Buffer.concat([Buffer.from([TAPROOT_LEAF_VERSION]), compactSizeBuffer(script.length), script]))
}

// bitcoinjs-lib refuses any P2TR construction until an ECC backend is
// registered. Registered lazily on the first envelope build rather than at
// module load so the non-envelope lanes (and the browserify bundle) never pay
// for the wasm-backed tiny-secp256k1 at startup.
let eccLibReady = false
function ensureEccLib() {
    if (eccLibReady) return
    bitcoin.initEccLib(require('tiny-secp256k1'))
    eccLibReady = true
}

// Narrow a satoshi amount computed in BigInt back to a Number when it is
// exactly representable, so consumers predating BigInt support (tests, PSBT
// inspectors) keep seeing Number for every value they could handle; only a
// genuinely >2^53-1 amount stays BigInt (the patched bitcoinjs/bip174
// serializers accept both).
function asSatValue(v) {
    return (typeof v === 'bigint' && v <= MAX_SAFE_SATOSHI_BIG) ? Number(v) : v
}

// JSON-safe form of a satoshi amount for OperationalError metadata:
// JSON.stringify throws on BigInt, so a >2^53-1 amount is emitted as its
// exact decimal string instead.
function jsonSafeSat(v) {
    if (typeof v !== 'bigint') return v
    return v <= MAX_SAFE_SATOSHI_BIG ? Number(v) : v.toString()
}

// Default ceiling on any caller-supplied fee, expressed as a multiple of the
// node's own estimatesmartfee(1) estimate. Without a cap, a malicious or buggy
// caller can set fee/feePerKb so high that every selected input is drained
// into miner fee (the user signs the PSBT none the wiser). Relative to the
// node estimate rather than absolute, so it tracks fee-market swings and works
// across chains with very different fee scales (BTC/LTC/DOGE). 100× passes any
// plausible priority/RBF fee (and fixed regtest test fees over quiet-chain
// estimates) while still rejecting drain-grade fees, which sit thousands of
// multiples above the market rate.
const DEFAULT_MAX_FEE_RATE_MULTIPLIER = 100

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

function isTestNetworkKey(networkKey){
    const key = String(networkKey || '').toLowerCase()
    return TEST_NETWORK_SUFFIXES.some(s => key.endsWith(s))
}

// The suggested-rate ceiling in BTC/byte for `networkKey`, or null when this
// chain is unclamped. SUGGESTED_FEE_MAX_PER_VBYTE overrides the default; 0
// disables the clamp entirely.
function suggestedFeeCeilingPerByte(networkKey, satoshiUnit){
    const raw = parseFloat(process.env.SUGGESTED_FEE_MAX_PER_VBYTE)
    const perVbyte = Number.isFinite(raw) ? raw
        : (isTestNetworkKey(networkKey) ? DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE : 0)
    if (!(perVbyte > 0)) return null
    return perVbyte / satoshiUnit
}

// Ceiling (in blocks) on how far the utxo-tracker's committed view may lag
// the chain tip before a tracker-fetched UTXO set is refused rather than
// risked (the "stale-utxo trap"). A lagging tracker can
// hand back a UTXO already spent on-chain, or omit one that only just
// confirmed, producing a PSBT the network silently rejects. The tracker's
// own general-purpose readiness signal (SYNCED_THRESHOLD, in
// xchain-utxo-tracker/src/XChainUtxoTracker.js) tolerates 3 blocks of catch-up
// lag; 2 is tighter here on purpose; spending money is a more sensitive
// operation than an average balance/UTXO read, and the tracker is expected to
// trail the tip by a block or two under normal polling cadence, so 2 absorbs
// that without false-positiving on routine operation.
const DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS = 2

// How long a selected outpoint stays reserved against concurrent selection.
// Long enough for a caller to sign and broadcast, short enough that an
// abandoned selection auto-releases without operator intervention. In-memory
// and best-effort only (the encoder is a single stateless process): this
// narrows, but cannot fully close, a same-address double-spend race. See the
// reservation helpers and the selection loop.
const RESERVATION_TTL_MS = 5 * 60 * 1000

// Resolve the 20-byte caller HASH160 that gates a P2SH/P2WSH chunk-lane reveal,
// from ANY caller identity form, not just a base58 legacy address. The reveal tx
// that spends a chunk output must satisfy an ordinary P2PKH gate (OP_DUP
// OP_HASH160 <hash160> OP_EQUALVERIFY OP_CHECKSIG) with the SOURCE key, so the
// returned hash MUST equal HASH160(that pubkey). It is the same 20 bytes whether
// the caller sends a base58 address, a raw pubkey hex, or a v0 bech32 P2WPKH
// address (whose witness program already IS that HASH160). The decoder reads
// ONLY the leading data chunk (redeemScript[0]) and never this trailer hash, so
// this is compose-side only with NO consensus/wire surface. Base58-only parsing
// used to throw "Non-base58 character" here, which broke every wallet flow (they
// send a raw compressed pubkey) and every bech32-only source.
function resolveCallerHash160(pubKey) {
    // Raw compressed (02/03 + 64 hex) or uncompressed (04 + 128 hex) pubkey first:
    // a base58 address can never match this shape (base58 excludes 0/O/I/l and
    // addresses do not start with "0"), so ordering it first is safe and never
    // changes legacy behavior.
    if (typeof pubKey === 'string' && /^(0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(pubKey)) {
        return bitcoin.crypto.hash160(Buffer.from(pubKey, 'hex'))
    }
    // Base58 P2PKH/P2SH address: byte-identical to the original behavior.
    try { return bitcoin.address.fromBase58Check(pubKey).hash } catch (_) { /* not base58 */ }
    // v0 bech32 P2WPKH: the 20-byte witness program already equals HASH160(pubkey).
    try {
        const dec = bitcoin.address.fromBech32(pubKey)
        if (dec.version === 0 && dec.data.length === 20) return dec.data
        throw new Error(`caller "${pubKey}" decodes to a v${dec.version} / ${dec.data.length}-byte witness program; the chunk-lane P2PKH gate needs a 20-byte HASH160 (v0 P2WPKH)`)
    } catch (e) {
        if (e && typeof e.message === 'string' && e.message.indexOf('witness program') !== -1) throw e
    }
    throw new Error(`prepareData: cannot resolve a 20-byte caller HASH160 from identity "${pubKey}" (expected a base58 P2PKH/P2SH address, a compressed/uncompressed pubkey hex, or a v0 bech32 P2WPKH address)`)
}

// Sibling of resolveCallerHash160, same "any identity in" contract, but for
// call sites that need an address STRING rather than a HASH160 (the UTXO
// tracker's getUtxosFromAddress, and the dust-padding fallback below). Wallet
// flows send their source as a raw compressed pubkey hex in this `pubkey`
// param, which is neither base58 nor bech32, so handing it straight to
// address.toOutputScript threw "<hex> has no matching Script" and failed every
// compose that did not pre-supply `utxos`.
// Address-type choice for a bare pubkey: this network's default (P2WPKH when
// segwit-capable, else legacy P2PKH), matching the wallet's own default address
// type per coin. A caller spending from a different address type (P2SH-P2WPKH,
// taproot) must pre-supply `utxos` or pass an explicit address, because a bare
// pubkey is inherently address-type-ambiguous.
function resolveCallerAddress(pubKey, network) {
    if (typeof pubKey !== 'string' || pubKey.length === 0) return pubKey
    // Already a valid address on this network: pass through unchanged.
    try { bitcoin.address.toOutputScript(pubKey, network); return pubKey } catch (_) { /* not a valid address here */ }
    // Raw compressed/uncompressed pubkey hex: derive the network's default address type.
    if (/^(0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(pubKey)) {
        const pubkeyBuf = Buffer.from(pubKey, 'hex')
        return (network.supportsSegwit === false
            ? bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network })
            : bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network })
        ).address
    }
    // Anything else: pass through unchanged and let the downstream call
    // (tracker / bitcoinjs-lib) surface its own, more specific error.
    return pubKey
}

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

// Deployment default for transparent FILE compression. ON unless
// the operator turns it off for a staged rollout; read per call rather than
// cached so a restart is not required to change it.
function defaultCompressionEnabled(){
    const raw = process.env.XCHAIN_COMPRESSION_DEFAULT
    if (raw === undefined || raw === null || raw === '') return true
    return !(raw === '0' || raw.toLowerCase() === 'false' || raw.toLowerCase() === 'off')
}

// Bind the reveal's marker key to the outpoint it actually spends.
// The P2SH/P2WSH reveal obfuscates its OP_RETURN marker with the id of the
// funding tx parsed from p2shHex, but builds every input outpoint from the
// separately supplied p2shHash, and nothing checked the two agree. A caller
// mixing the id of one funding tx with the hex of an equivalent other one still
// produced a signable, broadcastable reveal, while the decoder derives its key
// from the input's real txid, fails the magic-word check, and silently drops the
// paid ACTION. Called right after the hex is parsed, so it fires before the
// marker is obfuscated and before any input is added.
function assertRevealFundingTxMatches(p2shHash, fundingTxid){
    if (!p2shHash) return
    if (String(p2shHash).toLowerCase() !== String(fundingTxid).toLowerCase()){
        throw new TypeError(
            `p2shHash (${p2shHash}) does not match the txid of the supplied p2shHex transaction (${fundingTxid}); ` +
            `the reveal would spend one funding transaction while keying its marker to another`
        )
    }
}


class XChainEncoder {
    constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, utxoTrackerUrl, utxoTrackerPort, maxFeeRateKb=null, maxFeeRateMultiplier=DEFAULT_MAX_FEE_RATE_MULTIPLIER, maxUtxoTrackerLagBlocks=DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
      // The raw "<coin>-<net>" key. getBitcoinJsNetwork returns only the
      // bitcoinjs params, which carry no chain identity, and the envelope
      // recognition gate needs to know WHICH chain+network it is building for.
      this.networkKey = network
      this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
      this.utxoTrackerConnector = new UtxoTracker(utxoTrackerUrl, utxoTrackerPort)
      this.dustAmount = this.network["dustThreshold"]
      // Maximum fee rate in BTC/byte (null = no cap). Prevents runaway estimates
      // (e.g. regtest feedback loop) from producing fees that the node will reject.
      // MAX_FEE_RATE_KB is in sat/kB, convert to BTC/byte to match feePerBytes units.
      this.maxFeePerBytes = maxFeeRateKb ? maxFeeRateKb / 1000 / SATOSHI_UNIT : null
      // Relative fee-rate ceiling: caller-supplied fee/feePerKb may not exceed
      // this multiple of the node's current estimate (0/null disables).
      this.maxFeeRateMultiplier = maxFeeRateMultiplier || null
      // See DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS above. `undefined`/`null` from an
      // unset or unparseable env var falls through to the class default via the
      // parameter default above (only a literal `undefined` triggers a JS default
      // parameter, so this normalizes `null` the same way).
      this.maxUtxoTrackerLagBlocks = (maxUtxoTrackerLagBlocks == null) ? DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS : maxUtxoTrackerLagBlocks
      // outpoint ("txid:vout") -> reservation-expiry epoch ms. Guards against
      // two concurrent create_tx calls for the same address both selecting the
      // same tracker-fetched UTXOs and emitting conflicting double-spends. Only
      // engaged for tracker-fetched selections (caller-supplied UTXOs are the
      // caller's own coin-control). See RESERVATION_TTL_MS.
      this.outpointReservations = new Map()
    }

    // A reserved outpoint is one an in-flight selection has claimed and not yet
    // released. Expired entries are treated as free and lazily evicted here.
    _isOutpointReserved(key, now) {
        const expiry = this.outpointReservations.get(key)
        if (expiry == null) return false
        if (expiry <= now) {
            this.outpointReservations.delete(key)
            return false
        }
        return true
    }

    // Returns the expiry it wrote, which doubles as this claim's ownership stamp
    // (see _releaseCallReservations).
    _reserveOutpoint(key, now) {
        const expiry = now + RESERVATION_TTL_MS
        this.outpointReservations.set(key, expiry)
        return expiry
    }

    // Reserve an outpoint AND record the claim on the calling createTransaction's
    // own ledger, so a later throw can hand it back.
    _claimOutpoint(callReservations, key, now) {
        callReservations.push({ key, expiry: this._reserveOutpoint(key, now) })
    }

    // Release the reservations a single createTransaction call took, and only
    // those. The stored expiry is the ownership stamp: while a claim is live no
    // other call can take that outpoint (the selection loop skips reserved keys),
    // so the only way the map value can differ from what this call wrote is that
    // its claim already lapsed and somebody else re-reserved the outpoint against
    // a later clock. A mismatch therefore means the entry is foreign, and dropping
    // a foreign entry would reopen the same-address double-spend window the
    // reservation map exists to close. Leave it.
    _releaseCallReservations(callReservations) {
        for (const claim of callReservations) {
            if (this.outpointReservations.get(claim.key) === claim.expiry){
                this.outpointReservations.delete(claim.key)
            }
        }
    }

    // Sweep expired reservations so the map cannot grow unbounded across a
    // long-lived process. Called opportunistically at the start of selection.
    _evictExpiredReservations(now) {
        for (const [key, expiry] of this.outpointReservations) {
            if (expiry <= now) this.outpointReservations.delete(key)
        }
    }

    // Explicit release of all reservations. The encoder holds no durable state,
    // so this is primarily a test seam; production relies on the TTL.
    clearReservations() {
        this.outpointReservations.clear()
    }
    
    isSegwitUTXO(utxo) {
        try {
            const script = bitcoin.script.decompile(Buffer.from(utxo.scriptPubKey, 'hex'));
            // A witness program is exactly [version opcode][2..40 byte push]: OP_0
            // (0x00) for v0 (P2WPKH/P2WSH), OP_1..OP_16 (0x51..0x60) for v1..v16.
            // Taproot is v1, so the old v0-only check (script[0] === 0x00) treated
            // P2TR UTXOs as legacy and set nonWitnessUtxo instead of witnessUtxo -
            // but Taproot signing (and the MuSig2 co-signer) require witnessUtxo.
            if (!script || script.length !== 2 || !Buffer.isBuffer(script[1])) return false;
            const version = script[0];
            const isWitnessVersion = version === bitcoin.opcodes.OP_0 ||
                (version >= bitcoin.opcodes.OP_1 && version <= bitcoin.opcodes.OP_16);
            return isWitnessVersion && script[1].length >= 2 && script[1].length <= 40;
        } catch (error) {
            return false;
        }
    }
    
    prepareData(data, encoding, pubKey, compressedPubKey){
        let magicWordBuffer = Buffer.from(MAGIC_WORD,'utf8')
        
        if (!encoding){
            if (data.length + magicWordBuffer.length <= OP_RETURN_SIZE) {
                encoding = Encoding.OP_RETURN
            } else {
                encoding = Encoding.P2SH
            }
        }       
        let chunksSize = 0
        let dataBufferArray = []
        let i = 0
        let nextDataChunk = null
        switch (encoding){
            case Encoding.OP_RETURN:
                chunksSize = OP_RETURN_SIZE - magicWordBuffer.length //Single OP_RETURN output: 80-byte limit minus 4-byte magic word = 76 bytes of payload

                // All supported chains (BTC, LTC, DOGE) inherit Bitcoin Core's
                // IsStandardTx rule that rejects any transaction with more than one
                // nulldata/OP_RETURN output as non-standard ("multi-op-return"). A split
                // payload builds a structurally valid PSBT that fails silently at broadcast
                // and burns the fee UTXOs. The auto-selection path avoids this by falling
                // back to P2SH; the explicit-encoding path must reject loudly here instead.
                //
                // The single-output 80-byte ceiling is enforced unconditionally.
                // singleOpReturnPolicy:false used to skip this throw and fall
                // through to a multi-chunk split loop instead: no shipped decoder
                // can reassemble a payload split across multiple OP_RETURN pushes
                // (it only ever reads a single OP_RETURN output), and no shipped
                // coin relays a multi-OP_RETURN transaction as standard, so that
                // path was a fee-burning, undecodable-transaction trap armed by one
                // config flag rather than a real opt-out. Fail-closed
                // unconditionally now, the same as when the flag is absent.
                if (data.length > chunksSize) {
                    throw new RangeError(
                        `OP_RETURN encoding requires compiled payload <= ${chunksSize} bytes; ` +
                        `got ${data.length}. Use P2SH for larger payloads.`
                    )
                }

                // data.length <= chunksSize is now guaranteed above, so the
                // payload always compiles to exactly one OP_RETURN chunk.
                dataBufferArray.push(Buffer.concat([magicWordBuffer,data]))

                return {"dataBufferArray":dataBufferArray, "encoding": encoding}
            case Encoding.P2SH:
            case Encoding.P2WSH:
                /* REDEEM SCRIPT (exactly as compiled below)
                <data_chunk>       // the on-wire data push (max chunksSize bytes)
                +
                OP_DROP            // 1 byte  - drops the data so it never gates the spend
                +
                OP_DUP             // 1 byte
                +
                OP_HASH160         // 1 byte
                +
                <hash160>          // 20-byte HASH160 of the caller key
                                   //   (resolveCallerHash160(pubKey): base58 addr,
                                   //   raw pubkey hex, or v0 bech32 P2WPKH all yield
                                   //   the same HASH160(pubkey)), NOT a 33-byte pubkey
                +
                OP_EQUALVERIFY     // 1 byte
                +
                OP_CHECKSIG        // 1 byte
                //
                // The trailing five ops form an ordinary P2PKH gate; the data rides
                // in the leading push and is discarded at spend time by OP_DROP.
                // There is no n / OP_DEPTH / 0 / OP_EQUAL tail (that older sketch
                // never matched the compiled script).
                */

                chunksSize = (encoding == Encoding.P2SH?P2SH_SIZE:PW2SH_SIZE) - 44 // 44 is a conservative per-chunk overhead reservation that leaves headroom under the 520-byte consensus MAX_SCRIPT_ELEMENT_SIZE (P2SH_SIZE/PW2SH_SIZE) for the OP_DROP/OP_DUP/OP_HASH160/<hash160>/OP_EQUALVERIFY/OP_CHECKSIG trailer plus the leading data-push prefix. Each chunk becomes one P2SH/P2WSH output; the input spending it carries the data inside its redeem/witness script.
                
                let pubkeyFromBase58 = resolveCallerHash160(pubKey)

                // Slice the chunk boundaries first so a degenerate 1-byte final
                // chunk can be rebalanced before compile. bitcoin.script.compile
                // applies asMinimalOP: a lone data byte of 0x01-0x10 or 0x81
                // canonicalizes to a bare opcode, and the decoder's redeem-script
                // Buffer gate (XChainDecoder.js: !Buffer.isBuffer(decodedRedeemScript[0]))
                // then silently skips that output, corrupting reassembly of an
                // otherwise-valid multi-byte payload. Shifting one byte from the
                // penultimate chunk keeps every chunk >= 2 bytes; the decoder
                // reassembles by concatenation so moving a byte across the
                // boundary is transparent end-to-end.
                let p2shChunks = []
                i = 0
                while (i < data.length){
                    nextDataChunk = data.subarray(i,i+chunksSize)
                    p2shChunks.push(nextDataChunk)
                    i = i + nextDataChunk.length
                }
                if (p2shChunks.length >= 2){
                    let last = p2shChunks[p2shChunks.length - 1]
                    if (last.length === 1 && ((last[0] >= 0x01 && last[0] <= 0x10) || last[0] === 0x81)){
                        // Repartition the final two chunks: penultimate drops its
                        // last byte, final grows to 2 bytes. Both are re-sliced
                        // from `data` so the concatenation is byte-identical.
                        let prevStart = data.length - 1 - p2shChunks[p2shChunks.length - 2].length
                        p2shChunks[p2shChunks.length - 2] = data.subarray(prevStart, data.length - 2)
                        p2shChunks[p2shChunks.length - 1] = data.subarray(data.length - 2)
                    }
                }

                for (const chunk of p2shChunks){
                    let nextDataBuffer = bitcoin.script.compile([
                        chunk,
                        bitcoin.opcodes.OP_DROP,
                        bitcoin.opcodes.OP_DUP,
                        bitcoin.opcodes.OP_HASH160,
                        pubkeyFromBase58,
                        bitcoin.opcodes.OP_EQUALVERIFY,
                        bitcoin.opcodes.OP_CHECKSIG,
                    ])

                    dataBufferArray.push(nextDataBuffer)
                }

                return {"dataBufferArray":dataBufferArray, "encoding": encoding}
            case Encoding.MULTISIGN:
                chunksSize = MULTISIGN_SIZE 
                    - magicWordBuffer.length 
                    - 1 //1 byte for the OP_CHECKMULTISIG
                    - 1 //1 byte for the m signatures to pop
                    - 1 //1 byte for the n addresses to pop
                    - 1 //1 byte for the first address length
                    - 1 //1 byte for the second address length
                
                // Each MULTISIGN output carries its data across two 32-byte
                // pubkey halves (64 data bytes total). A full chunk is already
                // magic(4) + 60 = 64 bytes, but the final chunk is shorter.
                // Zero-pad every chunk up to the full 64-byte slot so BOTH
                // pubkey halves are always complete 32-byte values. Without
                // this, a short final chunk leaves the second half empty (or
                // near-empty); dataToPubkey() then produces an all-zero /
                // low-entropy EC point that bitcoinjs-lib rejects as not a
                // valid point. The reader strips this trailing pad using the
                // payload's own self-describing compiled-script length, so the
                // padding is invisible end-to-end.
                let multisignSlotSize = 64

                i = 0
                while (i < data.length){
                    nextDataChunk = data.subarray(i,i+chunksSize)
                    let nextChunk = Buffer.concat([magicWordBuffer,nextDataChunk])
                    if (nextChunk.length < multisignSlotSize){
                        nextChunk = Buffer.concat([nextChunk, Buffer.alloc(multisignSlotSize - nextChunk.length, 0)])
                    }
                    dataBufferArray.push(nextChunk)
                    i = i + nextDataChunk.length
                }

                return {"dataBufferArray":dataBufferArray, "encoding": encoding}
            case Encoding.TAPROOT: {
                /* TAPROOT ENVELOPE LEAF (grammar frozen at review)
                OP_FALSE OP_IF
                  <"XCHN">            // 4-byte magic, CLEARTEXT (same constant as every lane)
                  <0x00>              // format byte v0, cleartext
                  <payload push 1..n> // raw payload, 520-byte elements, in order
                OP_ENDIF
                <internal pubkey> OP_CHECKSIG
                //
                // The payload is the compiled action stream (`data` here: the
                // action-string push plus the rawData push), byte-identical to
                // what the chunk lanes carry, with the magic excluded because
                // the envelope header already carries it. Raw by design: the
                // shipped large-payload (P2WSH) precedent is unobfuscated, and
                // keying on the commit txid is circular by construction.
                */
                // The leaf tail and the key-path cancel both need the caller's
                // real pubkey; `pubKey` may be a bare address, so the explicit
                // compressedPubKey is required, mirroring MULTISIGN.
                if (compressedPubKey == null) {
                    throw new TypeError('compressedPubKey is required for TAPROOT encoding (it becomes the envelope internal key)')
                }
                if (typeof compressedPubKey !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(compressedPubKey)) {
                    throw new TypeError('compressedPubKey must be a 66-character hex string starting with 02 or 03')
                }
                const internalPubkey = Buffer.from(compressedPubKey, 'hex').subarray(1)

                chunksSize = TAPROOT_ENVELOPE_CHUNK_SIZE
                let envelopeChunks = []
                i = 0
                while (i < data.length){
                    nextDataChunk = data.subarray(i, i + chunksSize)
                    envelopeChunks.push(nextDataChunk)
                    i = i + nextDataChunk.length
                }
                // Same degenerate-final-chunk rebalance as the P2SH/P2WSH lane:
                // bitcoin.script.compile canonicalizes a lone 0x01-0x10/0x81 byte
                // to a bare opcode (asMinimalOP), which would corrupt the
                // concatenation the decoder reassembles. Shift one byte across
                // the final boundary so every push stays >= 2 bytes. (A 1-byte
                // TOTAL payload cannot occur: the compiled stream always leads
                // with a push opcode, so any non-empty payload is >= 2 bytes.)
                if (envelopeChunks.length >= 2){
                    let last = envelopeChunks[envelopeChunks.length - 1]
                    if (last.length === 1 && ((last[0] >= 0x01 && last[0] <= 0x10) || last[0] === 0x81)){
                        let prevStart = data.length - 1 - envelopeChunks[envelopeChunks.length - 2].length
                        envelopeChunks[envelopeChunks.length - 2] = data.subarray(prevStart, data.length - 2)
                        envelopeChunks[envelopeChunks.length - 1] = data.subarray(data.length - 2)
                    }
                }

                const envelopeScript = bitcoin.script.compile([
                    bitcoin.opcodes.OP_0, // OP_FALSE
                    bitcoin.opcodes.OP_IF,
                    magicWordBuffer,
                    Buffer.from([TAPROOT_ENVELOPE_FORMAT_V0]),
                    ...envelopeChunks,
                    bitcoin.opcodes.OP_ENDIF,
                    internalPubkey,
                    bitcoin.opcodes.OP_CHECKSIG,
                ])

                // dataBufferArray carries exactly ONE element: the whole
                // envelope tapscript. The emission loop turns it into one
                // commit output; there is no per-chunk output fan-out.
                return {"dataBufferArray":[envelopeScript], "encoding": encoding, "internalPubkey": internalPubkey}
            }
            default:
                throw new TypeError(`Unknown encoding: "${encoding}". Valid values: OP_RETURN, P2SH, MULTISIGN, P2WSH, TAPROOT`)
        }
    }
    
    async obfuscate(data, key){
        var cipherKey = key.substr(0,16)
        var iv = key.substr(16,16)
        
        var cipher = crypto.createCipheriv('aes-128-ctr', cipherKey, iv);
        var encryptedData = cipher.update(data)
        encryptedData = Buffer.concat([encryptedData,cipher.final()])
        return encryptedData
    }
    
    async dataToPubkey(data){
        let bufferArray = [Buffer.from("02","hex"),data]
        let bufferFill = null
        if (data.length < 32){
            bufferFill = Buffer.allocUnsafe(32 - data.length)
            bufferFill.fill("00", 0, bufferFill.length, "hex")
            bufferArray.push(bufferFill)
        }
        
        return Buffer.concat(bufferArray)
    }
    
    /**
     * Refuse to build a Taproot envelope that decoders would ignore.
     *
     * Envelope recognition activates at a per-network height. Below it every decoder
     * treats the reveal as an ordinary P2TR spend, so the caller would pay a real
     * miner fee, write a real payload on chain, and own an action that does not
     * exist. That refusal is silent and correct by design and nothing downstream can
     * detect the loss, which is exactly why the check has to live here. Fail-closed
     * on an unknown height too: a node that cannot answer getblockcount leaves us
     * unable to prove recognition is active, and guessing wrong costs the caller
     * real money.
     *
     * `null` means the network never recognizes envelopes (DOGE: no segwit). That is
     * already refused by the supportsSegwit gate; this repeats it as a safety net for
     * any future non-segwit chain whose definition is added without one.
     */
    async assertEnvelopeRecognized(){
        const height = CryptoNetworks.getEnvelopeRecognitionHeight(this.networkKey)
        if (height === null || height === undefined) {
            throw new TypeError('TAPROOT encoding is not recognized on this network; ' +
                'no envelope recognition height is defined for it')
        }
        if (height === 0) return                    // genesis-active (testnet/regtest)

        const tip = this.connector && typeof this.connector.getBlockCount === 'function'
            ? await this.connector.getBlockCount()
            : null
        if (!Number.isFinite(tip)) {
            const e = new Error('Cannot confirm Taproot envelope recognition is active on this network ' +
                `(recognition height ${height}); the node did not return a chain height. Refusing to build ` +
                'an envelope that decoders may ignore.')
            e.operational = true
            e.xchainCode = 'ENVELOPE_RECOGNITION_UNKNOWN'
            throw e
        }
        if (tip < height) {
            const e = new Error(`Taproot envelope recognition is not active on this network until block ${height} ` +
                `(chain tip ${tip}, ${height - tip} block(s) to go). An envelope broadcast now would cost a real ` +
                'fee and be ignored by every decoder, so it is refused. Use P2WSH until the activation height.')
            e.operational = true
            e.xchainCode = 'ENVELOPE_NOT_YET_ACTIVE'
            e.details = { recognitionHeight: height, chainTip: tip, blocksRemaining: height - tip }
            throw e
        }
    }

    // Public entry point. It owns the per-call reservation ledger: every outpoint
    // the build claims is recorded there, and if the build throws for ANY reason
    // (INPUT_SELECTION_RACE, INSUFFICIENT_FUNDS, a fee-cap RangeError, an upstream
    // node error) those claims are handed back immediately instead of squatting
    // until RESERVATION_TTL_MS. Without that, the retry an INPUT_SELECTION_RACE
    // error explicitly asks for hit its OWN dead reservations and came back
    // INSUFFICIENT_FUNDS for up to five minutes. The release is ownership-stamped
    // so a concurrent call's entries are never dropped; see
    // _releaseCallReservations. The success path keeps its reservations on purpose:
    // the caller is about to sign and broadcast those inputs.
    async createTransaction(...args){
        const callReservations = []
        try {
            return await this._buildTransaction(callReservations, ...args)
        } catch (err) {
            this._releaseCallReservations(callReservations)
            throw err
        }
    }

    async _buildTransaction(callReservations, utxos, pubkey, customOutputs, data, rawData, fee, replacebyfee,
      encoding, change, p2shHash=null, p2shHex=null, compressedPubKey=null,
      unconfirmed=true, feePerKb=null, dust=null, feeQuote=null, attachPrevTx=false, compress=null,
      options=null){

        // If feeQuote is provided, inject it as a custom output
        if(feeQuote && feeQuote.address && feeQuote.amount > 0){
            if(!customOutputs) customOutputs = [];
            customOutputs.push({ address: feeQuote.address, value: feeQuote.amount });
        }

        let feePerBytes = null
        let nodeFeePerBytes = null
        if (feePerKb){
            // feePerKb is the caller's rate in BASE UNITS (sat/litoshi/koinu)
            // per kB: docs/openrpc.json documents it as "base units per kB" and
            // the SDK's getFeeTiers() guidance is base-unit/vByte x 1000, the
            // same unit MAX_FEE_RATE_KB uses. Convert to the internal BTC/byte
            // that the node path (BTC/kB / 1000), the constructor cap
            // (maxFeeRateKb / 1000 / SATOSHI_UNIT), and the fee formula
            // (estimatedTxSize * feePerBytes * SATOSHI_UNIT) all share. The old
            // /1000-only conversion left this path 1e8x too large: with the
            // rate cap enabled every caller rate was silently clamped (fee
            // control inert), and with it disabled a documented sat/kB rate
            // produced a ~1e8x-inflated fee.
            feePerBytes = feePerKb/1000/SATOSHI_UNIT
            // Fetch the node's own estimate regardless of the multiplier
            // setting: it anchors the relative cap below AND the absolute burn
            // backstop, which must never derive its ceiling from the caller's
            // own rate (that would let an inflated feePerKb lift the ceiling
            // with it).
            try {
                nodeFeePerBytes = await this.connector.getFeePerKilobyte(1)/1000
            } catch (err) {
                // The node cannot produce an estimate (e.g. a quiet testnet,
                // exactly the case where callers must pass feePerKb to begin
                // with). The relative cap has no anchor; fall back to the
                // relayfee anchor below and the absolute MAX_FEE_RATE_KB cap,
                // if configured.
                console.warn('Relative fee cap skipped: node fee estimate unavailable:', err.message)
            }
        } else {
            feePerBytes = await this.connector.getFeePerKilobyte(1)/1000 //Highest fee. In bitcoin context every kilobyte is 1000 bytes
            nodeFeePerBytes = feePerBytes
            // Clamp only the rate chosen ON THE CALLER'S BEHALF, and only on a test
            // chain. nodeFeePerBytes keeps the raw estimate so the fee-drain caps
            // below still anchor to what the node actually reported.
            const suggestedCap = suggestedFeeCeilingPerByte(this.networkKey, SATOSHI_UNIT)
            if (suggestedCap != null && feePerBytes > suggestedCap){
                if (!this._suggestedFeeClampWarned){
                    this._suggestedFeeClampWarned = true
                    console.warn(`Suggested fee rate ${Math.round(feePerBytes * SATOSHI_UNIT)} per vByte exceeds the ` +
                        `test-chain ceiling; using ${Math.round(suggestedCap * SATOSHI_UNIT)} per vByte. ` +
                        `Set SUGGESTED_FEE_MAX_PER_VBYTE to change or 0 to disable.`)
                }
                feePerBytes = suggestedCap
            }
        }

        // Relative-cap anchor fallback. On non-regtest chains getFeePerKilobyte
        // THROWS when estimatesmartfee has no data (fresh node, warming mempool,
        // low activity), so the caller-supplied feePerKb path above leaves
        // nodeFeePerBytes null. Without an anchor the relative cap can't bound
        // feePerKb, and if no absolute MAX_FEE_RATE_KB is set either, the whole
        // fee-drain guard is OFF exactly when a caller supplies its own rate: a
        // hostile feePerKb then drains every input into miner fee. Fall back to
        // the node's min-relay fee (always available, coin-correct) as the cap
        // anchor, matching the regtest path in getFeePerKilobyte. This anchors
        // ONLY the ceiling, never the fee actually charged; a legitimate rate on
        // an empty mempool sits well under relayfee x multiplier anyway.
        // Deliberately NOT gated on maxFeeRateMultiplier: the absolute burn
        // backstop further down needs a caller-independent reference rate even
        // when the operator disables the relative cap (multiplier 0).
        if (nodeFeePerBytes == null){
            try {
                const info = await this.connector.getNetworkInfo();
                const relayfee = Number(info && info.relayfee);
                if (relayfee > 0) nodeFeePerBytes = relayfee / 1000;
            } catch (err) {
                console.warn('Fee cap relayfee-anchor fallback failed; feePerKb cap disabled this build:', err.message);
            }
        }

        // Effective fee-rate ceiling (BTC/byte): the tighter of the absolute
        // MAX_FEE_RATE_KB cap and the relative multiplier × node-estimate cap.
        // Bounds the per-byte rate used for fee estimation AND for sizing the
        // P2SH/P2WSH funding outputs, so a hostile feePerKb cannot drain the
        // caller's inputs into miner fee or over-funded data outputs.
        let capFeePerBytes = this.maxFeePerBytes
        if (this.maxFeeRateMultiplier && nodeFeePerBytes != null){
            const relativeCap = nodeFeePerBytes * this.maxFeeRateMultiplier
            capFeePerBytes = (capFeePerBytes != null) ? Math.min(capFeePerBytes, relativeCap) : relativeCap
        }
        if (capFeePerBytes != null && feePerBytes > capFeePerBytes) {
            console.warn(`Fee rate ${feePerBytes * 1000 * SATOSHI_UNIT} sat/kB exceeds the fee-rate cap, clamping to ${capFeePerBytes * 1000 * SATOSHI_UNIT} sat/kB`)
            feePerBytes = capFeePerBytes
        }
        
        let finalDust = this.dustAmount
        if (dust){
            finalDust = dust
        }
        
        // Transparent FILE payload compression, ON by default. Runs HERE, before
        // the payload buffers are assembled, so everything downstream prices the
        // bytes that will actually be written: the per-encoding ceiling check
        // below, the size estimator, the fee quote and the encoding selection.
        //
        // `compress` is TRI-STATE: true/false are the caller's explicit choice,
        // null/undefined take the deployment default. The distinction is not
        // cosmetic. An EXPLICIT request that cannot be honoured throws, because
        // the caller asked for something this payload cannot have; the DEFAULT
        // pass runs over every action, most of which are not compressible FILEs,
        // so the same conditions are ordinary facts and the payload rides raw
        // (see compression.js's `explicit` option). Without that split, turning
        // the default on would break every SEND carrying rawData.
        //
        // ROLLOUT: compression is consensus-safe but client-coordinated, because
        // an old reader serves a compressed FILE as deflated garbage. Reader
        // support must be deployed everywhere BEFORE an encoder carrying this
        // default, and XCHAIN_COMPRESSION_DEFAULT=0 is the deploy-time lever that
        // lets the code release and the behaviour change land separately.
        const compressExplicit = (compress === true || compress === false)
        const compressEnabled = compressExplicit ? compress : defaultCompressionEnabled()
        let compressionResult = null
        if (compressEnabled && rawData != null){
            let originalBuffer = Buffer.from(rawData, 'binary')
            compressionResult = await compressPayloadForAction(data, originalBuffer, { explicit: compressExplicit })
            if (compressionResult.compressed){
                // Both halves move together: the marker and the bytes it
                // describes. They must never be assigned separately.
                data = compressionResult.data
                rawData = compressionResult.rawData.toString('binary')
            }
        }

        // `data` is optional (openrpc.json create_tx data.required=false) and
        // validateAll passes null through when omitted, but Buffer.from(null,'utf8')
        // throws a Node TypeError, so a valid data-omitted request (e.g. a
        // payment-only tx built from customOutputs) would fail with an opaque
        // internal error. A missing payload defaults to '', identical to the
        // already-supported empty-string case, which compiles cleanly downstream.
        let dataBuffer = Buffer.from(data == null ? '' : data, 'utf8')
        let dataToCompile = [dataBuffer]

        if (rawData != null){
            // 'binary' (Latin-1) preserves bytes 0-255 one-to-one. 'utf8' would
            // corrupt arbitrary binary payloads (e.g. AES-GCM ciphertext for
            // token-gated FILEs, and deflate-raw output). Existing ASCII callers
            // like base64-encoded file bytes are byte-identical under both.
            let rawDataBuffer = Buffer.from(rawData, 'binary')
            dataToCompile.push(rawDataBuffer)
        }

        let finalDataBuffer = bitcoin.script.compile(dataToCompile)

        // Does this transaction carry an XChain ACTION at all?
        //
        // `data` being optional already meant "payment-only tx" in the wire
        // contract, but the emission path below still wrote a nulldata output
        // for it: the empty payload compiled to an OP_0 push, got the 4-byte
        // magic word prepended, and shipped as a magic-word-only OP_RETURN
        // carrying nothing. That is a real cost (a wasted output, and a
        // transaction that announces itself as XChain while containing no
        // action) paid by every plain native-coin payment the wallet sends.
        // A payment with nothing to say should look like an ordinary payment.
        const hasActionPayload = dataBuffer.length > 0 || rawData != null

        // rawData with no `data` compiles to an OP_0-led payload, and every shipped
        // decoder blanks that stream and never reads the trailing push (the arbiter gate
        // in xchain-decoder/src/XChainDecoder.js, which counts it and logs it but leaves
        // ACCEPTANCE unchanged on purpose). So the transaction confirms, the fee is paid,
        // and the payload is never indexed as an ACTION.
        //
        // Reported, not refused. Whether this wire shape becomes readable end to end is a
        // cross-service flag-day decision that governs the decoder gate and validator.js
        // together (see isMinimalOpSingleByte), so refusing it here would settle half of a
        // joint decision unilaterally and strand the decoder half when it lands. Telling
        // the fee-payer before it signs needs no acceptance change at all. Drop this when
        // the flag day lands.
        const rawDataOnlyPayload = dataBuffer.length === 0 && rawData != null

        // Size-aware encoding selection, behind the caller's explicit AUTO opt-in.
        // Runs HERE: after compression, so it prices the bytes that will really be
        // written, and before the ceiling check, so an over-cap payload is refused
        // against the lane that was actually chosen.
        //
        // Deliberately NOT the same thing as the legacy `!encoding` fallback in
        // prepareData (OP_RETURN, else P2SH), which stays exactly as shipped: a
        // caller who passes no encoding must keep getting today's bytes, because
        // auto-selecting TAPROOT changes the response from one PSBT to a
        // commit/reveal pair and no existing caller is ready for that.
        if (encoding === Encoding.AUTO){
            encoding = this.selectEncoding(finalDataBuffer.length, compressedPubKey, options)
        }

        // Enforce the compiled-push ceiling the indexing decoder applies, PER
        // ENCODING: every legacy lane keeps the 8,192-byte
        // MAX_ACTION_DATA_LENGTH (the decoder measures the compiled on-chain
        // push and silently drops anything larger, so reject at encode time);
        // only an explicit TAPROOT request gets the envelope ceiling. Note the
        // two constants measure slightly different things: the legacy guard is
        // framing-inclusive of the single on-chain push, the envelope ceiling
        // measures the reassembled payload (this same compiled stream) while
        // the envelope's own 520-byte push framing rides outside it.
        const compiledCeiling = (encoding === Encoding.TAPROOT) ? ENVELOPE_MAX_PAYLOAD : MAX_COMPILED_ACTION_DATA_LENGTH
        if (finalDataBuffer.length > compiledCeiling) {
            throw new RangeError(`Payload too large: compiled size ${finalDataBuffer.length} bytes exceeds maximum ${compiledCeiling} bytes (${encoding === Encoding.TAPROOT ? 'TAPROOT envelope payload ceiling' : 'compiled on-chain ACTION push'})`)
        }

        if (encoding === 'P2WSH' && this.network.supportsSegwit === false) {
            throw new TypeError('P2WSH encoding is not supported on this network (no segwit support)')
        }

        // Envelope availability is a property of the network definition:
        // DOGE has no segwit, hence no Taproot; same gate, same error shape as
        // P2WSH. The p2shHash guard exists for direct library callers (the API
        // validator already rejects it): TAPROOT is a single-call flow that
        // returns the commit/reveal pair together, never a second reveal call.
        if (encoding === Encoding.TAPROOT) {
            if (this.network.supportsSegwit === false) {
                throw new TypeError('TAPROOT encoding is not supported on this network (no segwit support)')
            }
            if (p2shHash) {
                throw new TypeError('TAPROOT encoding does not use the p2shHash reveal flow; one create_tx call returns the commit and reveal PSBTs together')
            }
            // Segwit support is NOT sufficient. Below the network's recognition
            // height every decoder ignores an envelope reveal, so building one here
            // would hand the caller a valid, broadcastable, correctly signed pair for
            // an action that will never exist, and they pay real coin for it. The
            // decoder's refusal is silent and correct, so nothing downstream can
            // detect the loss; this is the only place it can be caught.
            await this.assertEnvelopeRecognized()
            ensureEccLib()
        }

        let psbt = null
        
        let utxoSequence = (replacebyfee? 0x00000001: 0xffffffff)
        // BigInt: a DOGE UTXO set can total past 2^53-1 sats, where Number
        // arithmetic silently rounds the fee/change math.
        let inputSatoshis = 0n

        // The P2SH/P2WSH reveal (phase 2) spends phase-1's OWN funding outputs,
        // reconstructed from p2shHex further below; it never selects spendable
        // UTXOs. Re-querying the tracker on the reveal is not just wasted work:
        // the sender address is often already empty (phase 1 moved the funds on
        // chain), so tracker lag or that empty post-phase-1 view would strand a
        // mid-flow reveal. Derive inputs from the phase-1 context we were handed
        // and skip the tracker entirely; fall back to it only if the phase-1 hex
        // is somehow missing (an invalid reveal call).
        const isReveal = !!p2shHash
        let fetchedFromTracker = false

        if ((utxos == null) || (utxos.length == 0)){
            if (isReveal && p2shHex){
                utxos = []
            } else {
                let fetched
                try {
                    fetched = await this.utxoTrackerConnector.getUtxosFromAddress(resolveCallerAddress(pubkey, this.network))
                } catch (err) {
                    // Surface a typed, credential-free operational error. A
                    // transport failure embeds the tracker's internal host:port,
                    // so upstreamErrorMessage collapses it to the generic
                    // fallback; the tracker's own application messages (lag,
                    // address-too-large) are safe and actionable and pass through.
                    throw new OperationalError('UTXO_TRACKER_ERROR', upstreamErrorMessage(err, 'UTXO tracker unavailable'))
                }

                // Freshness gate. get_utxos carries an additive
                // `sync` sibling field ({tracker_height, node_height, lag, synced,
                // mempool_ready, halted?, halt_reason?}) on trackers that have picked up
                // the ce16bdd freshness surface. Refuse to select from a view the tracker
                // itself flags NOT synced or NOT mempool-ready, one it has halted on, or
                // one whose lag is outside our own (tighter) bounds, before any input is
                // chosen.
                // `sync` is absent on an older tracker: fail OPEN (old behavior) rather
                // than block every create_tx, since this ships ahead of every tracker
                // in the fleet being upgraded.
                const sync = fetched && fetched.sync
                if (sync && typeof sync === 'object'){
                    const lag = (typeof sync.lag === 'number') ? sync.lag : null
                    const overLag = (lag !== null) && (lag > this.maxUtxoTrackerLagBlocks)
                    // Negative lag: the tracker's committed tip sits ABOVE the node's,
                    // so its outputs live in blocks the node reset or reorged away. Only
                    // the upper bound was checked, so an orphaned view reached selection.
                    const behindNode = (lag !== null) && (lag < 0)
                    // Halted: the tracker stopped polling on an unrecoverable reorg and
                    // froze, possibly mid-rollback. It publishes this independently of
                    // `synced`, so a frozen height with an acceptable lag passed this
                    // gate. Strict === true keeps an older tracker, whose
                    // sync sibling carries no halt marker, on the existing fail-open path.
                    if (sync.halted === true){
                        throw new OperationalError(
                            'UTXO_TRACKER_HALTED',
                            `utxo-tracker is halted (${sync.halt_reason || 'unrecoverable reorg'}); refusing to select utxos from it`,
                            { lag, tracker_height: sync.tracker_height, node_height: sync.node_height, halt_reason: sync.halt_reason || null }
                        )
                    }
                    // Position before readiness, most specific cause first. An orphaned or
                    // lagging view de-asserts mempool_ready too (the tracker floors that
                    // field on the same negative lag), so checking readiness first would
                    // name mempool reconvergence for a fault that is really a node reset.
                    if (sync.synced === false || overLag || behindNode){
                        throw new OperationalError(
                            'UTXO_TRACKER_STALE',
                            `utxo-tracker view is stale (lag ${lag === null ? 'unknown' : lag} blocks` +
                            `${overLag ? `, exceeds ${this.maxUtxoTrackerLagBlocks}-block threshold` : ''}` +
                            `${behindNode ? `, tracker is ahead of the node so its view is orphaned` : ''}); refusing to select utxos from it`,
                            { lag, tracker_height: sync.tracker_height, node_height: sync.node_height }
                        )
                    }
                    // Mempool readiness: block sync flips true before the first mempool
                    // rebuild finishes, and until it does an empty mempool index cannot
                    // filter a confirmed output that is already spent in the node's
                    // mempool, so selection can pick an unspendable input.
                    // Strict === false again fails open for a pre-mempool_ready tracker.
                    if (sync.mempool_ready === false){
                        throw new OperationalError(
                            'UTXO_TRACKER_NOT_READY',
                            'utxo-tracker has not reconverged its mempool yet, so an already-spent confirmed output cannot be filtered; refusing to select utxos from it',
                            { lag, tracker_height: sync.tracker_height, node_height: sync.node_height }
                        )
                    }
                }

                utxos = fetched["utxos"]

                // The tracker's utxos field must be an array. Anything else with a
                // length (a string, most plausibly an error body that got read as the
                // payload) walks straight past the emptiness check below and is then
                // indexed element by element, so a malformed tracker response surfaced
                // as "utxos[0] must be an object" and pointed the operator at a UTXO
                // that does not exist instead of at the response shape.
                if ((utxos != null) && !Array.isArray(utxos)){
                    throw new OperationalError(
                        'UTXO_TRACKER_ERROR',
                        `utxo-tracker returned a utxos field that is not an array (got ${typeof utxos})`
                    )
                }

                if ((utxos == null) || (utxos.length == 0)){
                    throw new OperationalError('NO_UTXOS', "no utxos were provided and no utxos found on the blockchain")
                }
                fetchedFromTracker = true

                //Tracker-fetched UTXOs bypass the caller-API validation path, yet
                //feed into the same PSBT construction code below. Run each through
                //the same per-entry checks (64-char hex txid, integer vout/value,
                //non-empty scriptPubKey hex, confirmations defaulted) so a
                //malformed tracker output is rejected here instead of throwing
                //deep inside bitcoinjs-lib's psbt.addInput(). Deliberately
                //per-entry, NOT validateUtxoArray: the latter also enforces the
                //caller-facing MAX_UTXO_COUNT cap, which must NOT gate an
                //internally-fetched set (an address holding more than that many
                //UTXOs would otherwise be unable to build any transaction). The
                //SELECTED input count is bounded after selection instead.
                for (let vi = 0; vi < utxos.length; vi++){
                    validateUtxoEntry(utxos[vi], vi)
                }
            }
        }

        //Remove duplicated utxos (the utxo tracker returns duplicated utxos sometimes, this should be fixed)
        //Also if unconfirmed is false, then all mempool txs will be eliminated
        let utxoIndex = 0
        while (utxoIndex < utxos.length){
            let nextUtxo = utxos[utxoIndex]
            
            //if the tx is in the mempool, remove it if unconfirmed is false
            if (!unconfirmed && (nextUtxo.confirmations == 0)){
                utxos.splice(utxoIndex, 1)
            } else {
            
                let utxoDupIndex = utxoIndex + 1
                while (utxoDupIndex < utxos.length){
                    let nextUtxoDup = utxos[utxoDupIndex]
                    
                    if ((nextUtxoDup.txid == nextUtxo.txid) && (nextUtxoDup.vout == nextUtxo.vout)){
                        utxos.splice(utxoDupIndex, 1)
                    } else {
                        utxoDupIndex = utxoDupIndex + 1
                    }
                }
                
                utxoIndex = utxoIndex+1
            }
        }

        //If unconfirmed=false stripped every mempool UTXO and nothing
        //confirmed remains, surface the same error as a never-funded
        //address rather than crashing on utxos[0] below. The reveal path
        //legitimately has an empty utxos array here (its inputs come from
        //p2shHex), so only the funding/single-tx path treats empty as fatal.
        if (utxos.length == 0 && !isReveal){
            throw new OperationalError('NO_UTXOS', "no utxos were provided and no utxos found on the blockchain")
        }

        // Comparator, not subtraction: a >2^53-1 value is a BigInt here, and
        // BigInt - Number throws. Relational operators mix the two types fine.
        utxos.sort((a,b)=> a.value < b.value ? 1 : a.value > b.value ? -1 : 0)
        //On the reveal path utxos is empty; txidFirstInput is (re)assigned from
        //p2shHex inside the data loop below before it is ever read.
        //
        // The OP_RETURN/MULTISIGN obfuscation key MUST bind to the txid of the input actually
        // placed at ins[0]: the decoder derives its deobfuscation key from transaction.ins[0].
        // The selection loop below skips outpoints a concurrent/recent create_tx reserved
        // (tracker-fetched sets only), so sorted utxos[0] is NOT necessarily the first input.
        // Synchronously pre-reserve the first AVAILABLE outpoint now - before the async data
        // loop, so no concurrent call can claim it in between - and bind the key to it; the
        // selection loop carves this outpoint out of its skip check so it is taken as ins[0].
        // Without this, a reservation skip bound the key to utxos[0] while ins[0] was utxos[1],
        // the decoder failed the magic-word check, and the action silently never happened (valid
        // tx, inputs spent, fee burned).
        //
        // The carve-out alone is NOT enough. It guarantees the pre-reserved
        // outpoint is SELECTED, not that it is FIRST: the selection loop re-evaluates
        // reservations against a LATER clock, and _isOutpointReserved treats expiry <= now as
        // free, so a foreign reservation blocking an EARLIER-sorted outpoint that lapses during
        // the async data loop un-skips that outpoint and it takes ins[0] while the key stays
        // bound here. Move the key-bound outpoint to the head of the selection order so ins[0]
        // is correct by construction, independent of any clock.
        let firstReservedOutpoint = null
        let txidFirstInput = null
        if (utxos.length){
            if (fetchedFromTracker){
                const nowFirst = Date.now()
                this._evictExpiredReservations(nowFirst)
                for (let i = 0; i < utxos.length; i++){
                    const u = utxos[i]
                    const k = u.txid + ':' + u.vout
                    if (!this._isOutpointReserved(k, nowFirst)){
                        this._claimOutpoint(callReservations, k, nowFirst)
                        firstReservedOutpoint = k
                        txidFirstInput = u.txid
                        // Head-of-order splice. The skipped entries ahead of it were all
                        // reserved at nowFirst, so this only reorders against outpoints this
                        // call was never allowed to take anyway; if one of them frees before
                        // selection it is still selected, just after ins[0]. Value-descending
                        // order among the remaining entries is preserved.
                        if (i > 0) utxos.unshift(utxos.splice(i, 1)[0])
                        break
                    }
                }
                // Every fetched outpoint already reserved: nothing could be pre-reserved, so the
                // ins[0] invariant cannot be established by construction here. Fall back to
                // utxos[0] for a deterministic key. Usually the selection loop then selects
                // nothing and the build surfaces the shortfall, but its own eviction pass can
                // free a DIFFERENT outpoint first; the post-selection guard below catches that
                // and fails closed rather than emitting a silently-undecodable action.
                if (txidFirstInput === null) txidFirstInput = utxos[0]["txid"]
            } else {
                // Caller-supplied UTXOs are the caller's own coin-control; ins[0] is utxos[0].
                txidFirstInput = utxos[0]["txid"]
            }
            // Lowercase where the key BINDS, not only at validation: this string is the
            // obfuscation key itself, the decoder's half of it always renders lowercase,
            // and the ins[0] guard below compares against a lowercase hex rendering of the
            // PSBT input. validateUtxoEntry canonicalizes both ingest paths, but a caller
            // using the encoder as a library reaches createTransaction without it, and a
            // mixed-case txid must not turn into a permanent failure wearing a retryable
            // INPUT_SELECTION_RACE label.
            if (txidFirstInput != null) txidFirstInput = String(txidFirstInput).toLowerCase()
        }

        if (!p2shHash){//We need to prepare the data to know which inputs the p2sh will have
            psbt = new bitcoin.Psbt({ network: this.network })
        }
        
        // With no action payload there is nothing to encode, chunk or obfuscate,
        // so skip prepareData entirely and hand the emission loop an empty chunk
        // list: it then writes no nulldata output and the transaction is just its
        // customOutputs plus change. The encoding is reported as OP_RETURN because
        // every downstream single-transaction branch keys off that value (the
        // P2SH/P2WSH two-phase paths must not engage for a payment), and a caller
        // that explicitly asked for a chunked encoding while supplying no payload
        // has nothing to chunk regardless.
        let preparedData = hasActionPayload
            ? this.prepareData(finalDataBuffer, encoding, pubkey, compressedPubKey)
            : { encoding: Encoding.OP_RETURN, dataBufferArray: [] }

        // P2SH/P2WSH is a two-tx flow: this funding tx (p2shHash null) creates the
        // P2SH/P2WSH outputs, and a later reveal tx (p2shHash set) spends them and
        // is the tx the indexer treats as the action. customOutputs (e.g. the
        // native-fee protocol-fee output) must therefore be EMITTED on the reveal,
        // not here on the funding tx. But the reveal's only inputs are these funding
        // outputs, so the funding outputs must carry enough value for the reveal to
        // pay both its miner fee and those reveal-side customOutputs. We fold the
        // customOutputs total into the FIRST funding output here, and skip emitting
        // customOutputs on this funding tx below (see the customOutputs block). On
        // the reveal (p2shHash set) customOutputs ARE emitted, funded by this value,
        // so they are paid exactly once. Single-tx encodings (OP_RETURN/MULTISIGN)
        // are unaffected: they emit customOutputs directly on their only tx.
        //
        // Value alone is not enough. Each reveal-side customOutput also
        // makes the reveal BIGGER, and the reveal's whole miner fee comes from
        // these funding outputs. estimateSpendingP2shTx/estimateSpendingP2wshTx
        // size the reveal as "one data input + the OP_RETURN marker" only, so a
        // single-chunk reveal carrying e.g. a 34-byte native-fee output came up
        // ~25 bytes short of the 1 sat/vB floor and the node rejected it with
        // min-relay-fee-not-met. Multi-chunk reveals only survived by accident:
        // the per-chunk estimate repeats the tx header and marker output, and
        // that slack absorbed the missing bytes. So charge the bytes here too.
        const isP2shFamily = preparedData["encoding"] === Encoding.P2SH || preparedData["encoding"] === Encoding.P2WSH
        let revealCustomOutputsValue = 0n
        let revealCustomOutputsBytes = 0
        if (!p2shHash && isP2shFamily && customOutputs && Array.isArray(customOutputs)){
            for (let i = 0; i < customOutputs.length; i++){
                revealCustomOutputsValue += BigInt(parseSatoshiAmount(customOutputs[i].value, `customOutputs[${i}].value`, { allowBig: true }))
                revealCustomOutputsBytes += TxSizeEstimator.estimateOutputSizeForAddress(customOutputs[i].address, this.network)
            }
        }
        // Round UP: a truncated fraction of a satoshi is exactly the kind of
        // off-by-one that lands the reveal a hair under the relay floor.
        let revealCustomOutputsFee = (revealCustomOutputsBytes > 0 && feePerBytes > 0)
            ? Math.ceil(revealCustomOutputsBytes * feePerBytes * SATOSHI_UNIT)
            : 0

        let outputSatoshis = 0n
        let voutPsbtIndex = 0
        let obfuscatedData

        // Reconstructed phase-1 funding tx on the reveal path, shared by the P2SH
        // and P2WSH branches below (both spend its outputs by index). Hoisted to the
        // loop's enclosing scope so the input-index bounds guard can reuse it, and
        // parsed once (memoized via `!p2shTx`) rather than re-decoded per data chunk;
        // the parse is loop-invariant (p2shHex and txidFirstInput never change here).
        let p2shTx = null

        // Envelope (TAPROOT) build context, populated by the emission loop and
        // consumed after input selection to construct the reveal PSBT against
        // the unsigned commit's txid (stable: commit inputs are segwit-only).
        let envelopeContext = null

        let estimatedTxSize = 0

        for (let nextDataBufferIndex in preparedData["dataBufferArray"]){
            let nextDataBuffer = preparedData["dataBufferArray"][nextDataBufferIndex]
            
            switch (preparedData["encoding"]){
                case Encoding.OP_RETURN:
                
                    obfuscatedData = await this.obfuscate(nextDataBuffer, txidFirstInput)
                    let opReturnScript = bitcoin.payments.embed({ data: [obfuscatedData] })
                    
                    psbt.addOutput({
                        script: opReturnScript.output,
                        value: 0
                    })
                    
                    // Oversize is handled upstream: prepareData rejects an OP_RETURN
                    // payload larger than chunksSize (single-OP_RETURN policy throw),
                    // so every obfuscatedData reaching here fits one standard nulldata
                    // output and this per-chunk size estimate is exact.
                    estimatedTxSize = estimatedTxSize
                        + TxSizeEstimator.estimateOpReturnOutput(obfuscatedData)
                    
                    break
                case Encoding.P2SH:
                    if (p2shHex && !p2shTx){
                        p2shTx = bitcoin.Transaction.fromHex(p2shHex)
                        txidFirstInput = p2shTx.getId()
                        assertRevealFundingTxMatches(p2shHash, txidFirstInput)
                    }

                    if (p2shHash){
                        if (!psbt){
                            let opReturnData = await this.obfuscate(
                                Buffer.concat([
                                    Buffer.from(MAGIC_WORD,'utf8'),
                                    Buffer.from("p2sh",'utf8')
                                ]),
                                txidFirstInput
                            )
                        
                            psbt = new bitcoin.Psbt({ network: this.network })
                            psbt.addOutput({
                                script: bitcoin.payments.embed({
                                    data: [opReturnData]
                                }).output,
                                value: 0
                            })
                            
                            estimatedTxSize = estimatedTxSize
                                + TxSizeEstimator.estimateOpReturnOutput(opReturnData)
                        }
                        
                        if (!p2shTx || !p2shTx.outs || voutPsbtIndex >= p2shTx.outs.length) {
                            throw new RangeError(`p2shHex transaction does not have output at index ${voutPsbtIndex}`)
                        }
                        let nextInput = {
                            sequence: utxoSequence,
                            hash:p2shHash,
                            redeemScript:nextDataBuffer,
                            index: voutPsbtIndex,
                            nonWitnessUtxo:Buffer.from(p2shHex, 'hex')
                        }

                        psbt.addInput(nextInput)
                        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
                        
                        voutPsbtIndex = voutPsbtIndex + 1                   
                    } else {
                        let spendingP2shEstimatedSize = this.estimateSpendingP2shTx(nextDataBuffer)
                        let spendingP2shEstimatedFee = Math.trunc((spendingP2shEstimatedSize * feePerBytes) * SATOSHI_UNIT)

                        if (spendingP2shEstimatedFee < finalDust){
                            spendingP2shEstimatedFee = finalDust
                        }

                        // Over-fund the first funding output by the reveal-side
                        // customOutputs total, plus the miner fee for the bytes
                        // they add to the reveal, so the reveal can pay them
                        // (consumed once).
                        if (revealCustomOutputsValue > 0n || revealCustomOutputsFee > 0){
                            spendingP2shEstimatedFee = asSatValue(BigInt(spendingP2shEstimatedFee) + revealCustomOutputsValue + BigInt(revealCustomOutputsFee))
                            revealCustomOutputsValue = 0n
                            revealCustomOutputsFee = 0
                        }

                        psbt.addOutput({
                            address: bitcoin.payments.p2sh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
                            value:spendingP2shEstimatedFee
                        })

                        outputSatoshis = outputSatoshis + BigInt(spendingP2shEstimatedFee)
                        
                        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateP2shOutput()
                    }
                    
                    break
                case Encoding.P2WSH:
                    if (p2shHex && !p2shTx){
                        p2shTx = bitcoin.Transaction.fromHex(p2shHex)
                        txidFirstInput = p2shTx.getId()
                        assertRevealFundingTxMatches(p2shHash, txidFirstInput)
                    }
                    
                    if (p2shHash){
                        if (!psbt){
                            psbt = new bitcoin.Psbt({ network: this.network })
                            psbt.addOutput({
                                script: bitcoin.payments.embed({
                                    data: [
                                        await this.obfuscate(
                                            Buffer.concat([
                                                Buffer.from(MAGIC_WORD,'utf8'),
                                                Buffer.from("p2wsh",'utf8')
                                            ]),
                                            txidFirstInput
                                        )
                                    ]
                                }).output,
                                value: 0
                            })
                        }
                        
                        if (!p2shTx || !p2shTx.outs || voutPsbtIndex >= p2shTx.outs.length) {
                            throw new RangeError(`p2shHex transaction does not have output at index ${voutPsbtIndex}`)
                        }
                        let nextInput = {
                            sequence: utxoSequence,
                            hash:p2shHash,
                            witnessScript:nextDataBuffer,
                            index: voutPsbtIndex,
                            witnessUtxo:{
                                script:p2shTx["outs"][voutPsbtIndex]["script"],
                                value:p2shTx["outs"][voutPsbtIndex]["value"]
                            }
                        }
                        psbt.addInput(nextInput)
                        
                        estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
                        voutPsbtIndex = voutPsbtIndex + 1                   
                    } else {
                        // Size this P2WSH data output to fund its share of the
                        // reveal (spending) transaction's fee, mirroring the
                        // P2SH branch above. A flat per-output dust value leaves
                        // the multi-input reveal tx below the node's min-relay-fee
                        // floor (observed on bitcoin-regtest, whose dustThreshold
                        // is 546: 1638 sat across 3 dust outputs vs a ~2228 sat
                        // floor), so the broadcast is rejected. The estimate uses
                        // witness-discounted sizing because P2WSH
                        // reveal data lives in the (÷4-weighted) witness.
                        let spendingP2wshEstimatedSize = this.estimateSpendingP2wshTx(nextDataBuffer)
                        let spendingP2wshEstimatedFee = Math.trunc((spendingP2wshEstimatedSize * feePerBytes) * SATOSHI_UNIT)

                        if (spendingP2wshEstimatedFee < finalDust){
                            spendingP2wshEstimatedFee = finalDust
                        }

                        // Chains such as Litecoin reject a reveal tx whose
                        // stripped (non-witness) serialization is below their
                        // relay floor (minStandardTxNonWitnessSize). A reveal
                        // spending these data outputs is 10 (header) + 41 per
                        // P2WSH input + ~20 (OP_RETURN marker) stripped bytes; a
                        // single-chunk reveal is only 71 bytes, under Litecoin's
                        // 85-byte floor. The reveal builder clears the floor with
                        // one extra small payment output (see the p2shHash branch
                        // and addRevealSizeFloorPadding below), so fund that
                        // output's value here (one dust); otherwise the reveal
                        // has no satoshis left to create it after the fee floor.
                        let strippedFloor = this.network.minStandardTxNonWitnessSize
                        let chunkCount = preparedData["dataBufferArray"].length
                        let predictedRevealStripped = 30 + (41 * chunkCount)
                        if (strippedFloor && predictedRevealStripped < strippedFloor){
                            // Fund the reveal's stripped-size floor-padding output with
                            // this.dustAmount, the SAME constant the reveal side spends
                            // (see addRevealSizeFloorPadding below). Using finalDust here
                            // could over/under-fund the pad when a caller passes a custom
                            // dust, leaving the two halves of the flow inconsistent.
                            spendingP2wshEstimatedFee = spendingP2wshEstimatedFee + this.dustAmount
                        }

                        // Over-fund the first funding output by the reveal-side
                        // customOutputs total, plus the miner fee for the bytes
                        // they add to the reveal, so the reveal can pay them
                        // (consumed once).
                        if (revealCustomOutputsValue > 0n || revealCustomOutputsFee > 0){
                            spendingP2wshEstimatedFee = asSatValue(BigInt(spendingP2wshEstimatedFee) + revealCustomOutputsValue + BigInt(revealCustomOutputsFee))
                            revealCustomOutputsValue = 0n
                            revealCustomOutputsFee = 0
                        }

                        psbt.addOutput({
                            address: bitcoin.payments.p2wsh({ redeem: {output:nextDataBuffer}, network:this.network}).address,
                            value:spendingP2wshEstimatedFee
                        })
                        // Account for the data output's value so change is not
                        // over-credited. Without this, changeSatoshis below is
                        // computed as input - 0 - fee, so the data outputs are
                        // funded "for free" and total outputs exceed total
                        // inputs; bitcoinjs rejects tx1 with "Outputs are
                        // spending more than Inputs". Mirrors the P2SH and
                        // MULTISIGN branches, which already track their outputs.
                        outputSatoshis = outputSatoshis + BigInt(spendingP2wshEstimatedFee)

                        estimatedTxSize = estimatedTxSize
                            + TxSizeEstimator.estimateP2wshOutput()
                    }

                    break
                case Encoding.MULTISIGN:
                    obfuscatedData = await this.obfuscate(nextDataBuffer, txidFirstInput)
                    let pubkey1 = await this.dataToPubkey(obfuscatedData.slice(0, 32))
                    let pubkey2 = await this.dataToPubkey(obfuscatedData.slice(32, obfuscatedData.length))
                    let pubkey3 = Buffer.from(compressedPubKey,"hex")
                    
                    let pubkeys = [
                        pubkey1,
                        pubkey2,
                        pubkey3
                    ]
                    
                    let multisignScript = bitcoin.payments.p2ms(
                        { 
                            m:1, //We only need one signature
                            pubkeys: pubkeys,
                            network: this.network
                        }
                    )
                    
                    // A bare multisig output is larger than a P2PKH, so the P2PKH
                    // dust floor (this.dustAmount, read per network from the coin
                    // bundle's dustThreshold: BTC 546, LTC 5460, DOGE 100000) is
                    // below the node's relay dust threshold and the broadcast is
                    // rejected with {"code":-26,"message":"dust"}. Never hard-code a
                    // flat 546 here: DOGE shares this path at 100000. Size the floor
                    // from the actual output script using Bitcoin Core's dust formula:
                    // (output_bytes + spend_input_bytes) * 3 sat/byte. The spend cost
                    // assumes a 148-byte P2PKH-style input. For standard 1-of-3
                    // compressed-key scripts (105 bytes) this is ~786 sat.
                    let bareMultisigDust = Math.ceil((8 + 1 + multisignScript.output.length + 148) * 3)
                    let multisigOutputValue = Math.max(finalDust, bareMultisigDust)

                    psbt.addOutput({
                        script: multisignScript.output,
                        value: multisigOutputValue
                        })
                    // Account for the data output's value so change is not over-credited
                    // (otherwise total outputs exceed total inputs and the tx is invalid).
                    outputSatoshis += BigInt(multisigOutputValue)

                    estimatedTxSize = estimatedTxSize
                        + TxSizeEstimator.estimateMultisignOutput()

                    break
                case Encoding.TAPROOT: {
                    // nextDataBuffer IS the whole envelope tapscript (single
                    // element). One commit output carries it; the reveal is
                    // built after input selection, once the commit txid exists.
                    const internalPubkey = preparedData["internalPubkey"]
                    const commitPayment = bitcoin.payments.p2tr({
                        internalPubkey,
                        scriptTree: { output: nextDataBuffer },
                        network: this.network
                    })

                    // The reveal's only funding is the commit output, so its
                    // value must prefund the reveal's miner fee plus a change
                    // output at the dust floor (the reveal must carry at least
                    // one output; change doubles as the CPFP handle), plus
                    // the stripped-size floor pad where the chain demands one
                    // (LTC: a reveal whose only output is small sits under
                    // minStandardTxNonWitnessSize, exactly like the P2WSH
                    // reveal; the payload lives in the witness and does not
                    // count toward stripped size).
                    const revealChangeAddress = change || resolveCallerAddress(pubkey, this.network)
                    const revealChangeOutBytes = TxSizeEstimator.estimateOutputSizeForAddress(revealChangeAddress, this.network)
                    const envStrippedFloor = this.network.minStandardTxNonWitnessSize
                    const revealPadNeeded = !!(envStrippedFloor && (10 + 41 + revealChangeOutBytes) < envStrippedFloor)
                    const revealOutputsBytes = revealChangeOutBytes + (revealPadNeeded ? revealChangeOutBytes : 0)
                    const revealVsize = TxSizeEstimator.estimateEnvelopeRevealTx(nextDataBuffer.length, revealOutputsBytes, envStrippedFloor)
                    let revealFee = Math.trunc(revealVsize * feePerBytes * SATOSHI_UNIT)
                    if (revealFee < finalDust){
                        revealFee = finalDust
                    }
                    const commitValue = revealFee + this.dustAmount + (revealPadNeeded ? this.dustAmount : 0)

                    psbt.addOutput({
                        script: commitPayment.output,
                        value: commitValue
                    })
                    outputSatoshis = outputSatoshis + BigInt(commitValue)
                    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateTaprootOutput()

                    envelopeContext = {
                        internalPubkey,
                        envelopeScript: nextDataBuffer,
                        commitPayment,
                        commitValue,
                        revealFee,
                        revealPadNeeded,
                        revealChangeAddress
                    }
                    break
                }
            }
        }

        // Process custom outputs (e.g., COINPay native coin payment outputs, or
        // the native-fee protocol-fee output). On a P2SH/P2WSH FUNDING tx
        // (p2shHash null) these are NOT emitted here: their value was folded into
        // the funding outputs above so the reveal can pay them, and the reveal
        // (p2shHash set) emits them. Emitting here too would put the output on the
        // wrong tx (the indexer reads the reveal) and double-pay. Single-tx
        // encodings and the reveal itself fall through and emit normally.
        const skipCustomOutputs = !p2shHash && isP2shFamily
        if (!skipCustomOutputs && customOutputs && Array.isArray(customOutputs)) {
            for (let i = 0; i < customOutputs.length; i++) {
                const output = customOutputs[i]
                const outputValue = parseSatoshiAmount(output.value, `customOutputs[${i}].value`, { allowBig: true })
                // A 0-sat caller output is consensus-valid but relay-rejected as
                // dust, so the caller signs an unbroadcastable PSBT. Reject it at
                // the effector too (not just the validator boundary), matching the
                // native-fee output which is always positive (guarded at injection
                // above), so this never rejects a legitimate sub-dust FEE_DESTINATION
                // value. Interim safe rule: reject only value <= 0, not a full
                // per-network dust floor.
                if (outputValue <= 0) {
                    throw new RangeError(`customOutputs[${i}].value must be a positive integer (satoshis)`)
                }
                psbt.addOutput({
                    address: output.address,
                    value:   outputValue
                })
                outputSatoshis += BigInt(outputValue)
                estimatedTxSize += 43 // Taproot output size estimate (most expensive)
            }
        }

        estimatedTxSize = estimatedTxSize + 43 // change output (worst case: taproot)

        let estimatedFee = 0
        if (fee != null && fee !== false) {
            // Re-parse with the same exact-integer arbiter the validator uses
            // (toExactInt-based), not parseInt: parseInt silently truncates a
            // fractional value ("100.5" -> 100) for direct library callers that
            // bypass validateFee. parseSatoshiAmount throws RangeError
            // ("fee must be a non-negative integer") on any non-exact or negative
            // value, preserving the previous error contract.
            estimatedFee = parseSatoshiAmount(fee, 'fee')
        }
        
        let selectedInputCount = 0
        if (!p2shHash){//The p2sh input is already created before
            const now = Date.now()
            this._evictExpiredReservations(now)
            let nextUtxoIndex = 0
            while (nextUtxoIndex < utxos.length){
                let nextUtxo = utxos[nextUtxoIndex]

                // Envelope commit inputs MUST be segwit. The
                // reveal is pre-built against the UNSIGNED commit's txid, which
                // is only stable when no selected input's signature lands in
                // the txid-covered serialization. Enforced as native-segwit
                // (witness-program scriptPubKey): a P2SH-wrapped segwit UTXO is
                // indistinguishable from plain P2SH here and its scriptSig
                // (redeem-script push) shifts the txid, so it is refused too --
                // stricter than the spec's floor, never looser. Fail closed
                // rather than skip: silently dropping a caller's coin-control
                // input would change what they spend.
                if (preparedData["encoding"] === Encoding.TAPROOT && !this.isSegwitUTXO(nextUtxo)){
                    throw new TypeError(
                        `TAPROOT commit inputs must be native-segwit UTXOs (witness-program scriptPubKey); ` +
                        `utxo ${nextUtxo.txid}:${nextUtxo.vout} is not. A non-segwit input would shift the ` +
                        `commit txid at signing time and strand the pre-built reveal.`)
                }

                // Best-effort double-spend guard: when this set was fetched from
                // the tracker for the sender address, skip any outpoint another
                // in-flight create_tx just claimed, and reserve the ones we take.
                // Two concurrent calls for one address would otherwise both pick
                // the largest UTXOs and build conflicting double-spends. Reserve
                // synchronously here (before the getTransactionHex await below)
                // so a concurrent call observes the claim. Caller-supplied UTXOs
                // are the caller's own coin-control and are left unreserved.
                const outpointKey = nextUtxo.txid + ':' + nextUtxo.vout
                if (fetchedFromTracker){
                    // Skip outpoints reserved by OTHER in-flight calls, but NOT the one this
                    // call pre-reserved for ins[0] above (the obfuscation key binds to it).
                    if (outpointKey !== firstReservedOutpoint && this._isOutpointReserved(outpointKey, now)){
                        nextUtxoIndex = nextUtxoIndex + 1
                        continue
                    }
                    if (outpointKey !== firstReservedOutpoint){
                        this._claimOutpoint(callReservations, outpointKey, now)
                    }
                }

                nextUtxo.value = parseSatoshiAmount(nextUtxo.value, `utxos[${nextUtxoIndex}].value`, { allowBig: true })

                if (this.isSegwitUTXO(nextUtxo)){
                    let nextInput = {
                        hash: nextUtxo.txid,
                        index: nextUtxo.vout,
                        sequence: utxoSequence,
                        witnessUtxo: {
                            script: Buffer.from(nextUtxo.scriptPubKey, 'hex'),
                            value: nextUtxo.value,
                        }
                    }
                    // A hardware signer needs the FULL previous
                    // transaction even for a segwit input, because Ledger takes
                    // the outpoint it signs from those bytes rather than from
                    // the PSBT's own txid. witnessUtxo alone left the device
                    // unable to sign (and, before it failed closed, signing a
                    // synthesized outpoint that does not exist). Opt-in: it is
                    // one node round trip and one prev tx of PSBT weight per
                    // input, which only that caller should pay. Attached NOW,
                    // at build time, so the PSBT the user previews is the one
                    // that gets signed - hydrating it later would break the
                    // byte-identity guarantee the confirm surface rests on.
                    if (attachPrevTx) {
                        const prevTxHex = await this.connector.getTransactionHex(nextUtxo.txid)
                        nextInput.nonWitnessUtxo = Buffer.from(prevTxHex, 'hex')
                    }
                    psbt.addInput(nextInput)
                    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
                    inputSatoshis = inputSatoshis + BigInt(nextUtxo.value)
                } else {
                    let wholeUtxoHex = await this.connector.getTransactionHex(nextUtxo.txid)
                    let nextInput = {
                        hash: nextUtxo.txid,
                        index: nextUtxo.vout,
                        sequence: utxoSequence,
                        nonWitnessUtxo: Buffer.from(wholeUtxoHex, 'hex')
                    }
                    psbt.addInput(nextInput)
                    estimatedTxSize = estimatedTxSize + TxSizeEstimator.estimateInputSize(nextInput)
                    inputSatoshis = inputSatoshis + BigInt(nextUtxo.value)
                }

                selectedInputCount = selectedInputCount + 1

                if (fee == null || fee === false) {
                    estimatedFee = Math.trunc(estimatedTxSize * feePerBytes * SATOSHI_UNIT)
                }

                if (inputSatoshis > outputSatoshis + BigInt(estimatedFee)){
                    break
                }

                nextUtxoIndex = nextUtxoIndex + 1
            }

            // The caller-facing MAX_UTXO_COUNT cap is intentionally NOT
            // applied to the fetched set before selection (a rich address must
            // stay spendable). Bound the SELECTED input count instead: a tx that
            // genuinely needs more inputs than this is over standardness size and
            // would be rejected at broadcast, so fail here with a precise reason.
            if (selectedInputCount > MAX_UTXO_COUNT){
                throw new RangeError(`selected input count (${selectedInputCount}) exceeds the maximum (${MAX_UTXO_COUNT}) inputs for a single transaction`)
            }

            // No spendable input was selected on the funding/single-tx path: the
            // set was empty of usable outputs or every candidate is reserved by a
            // concurrent selection. Report insufficient funds here, before
            // the fee-rate cap math below, which would otherwise reject a fixed
            // fee against a zero-input transaction's tiny size and mask the real
            // cause. (The reveal path has p2shHash set and never reaches here.)
            if (selectedInputCount === 0){
                throw new OperationalError(
                    'INSUFFICIENT_FUNDS',
                    'insufficient funds: no spendable inputs available (all candidates reserved or empty)',
                    { required: jsonSafeSat(outputSatoshis + BigInt(estimatedFee)), available: 0, outputs: jsonSafeSat(outputSatoshis), fee: estimatedFee }
                )
            }

            // Fail-closed ins[0] invariant. OP_RETURN and MULTISIGN
            // obfuscate their payload with txidFirstInput, and the decoder derives its
            // deobfuscation key from the first input's txid, so the action only decodes if
            // that outpoint actually landed at ins[0]. The head-of-order splice above makes
            // that true by construction whenever an outpoint could be pre-reserved; it
            // cannot when EVERY fetched outpoint was already reserved and one of them then
            // freed before selection. Fail here so the caller retries, instead of returning
            // a valid transaction whose action silently decodes to nothing (inputs spent,
            // fee burned). P2SH/P2WSH are excluded: on the funding tx they do not use
            // txidFirstInput at all, and on the reveal tx (p2shHash set) this block does not
            // run and the key is re-bound to the phase-1 txid.
            // A payment-only transaction has no action, hence no
            // obfuscation key bound to the first input. The guard below exists to
            // stop an action from silently decoding to nothing; with nothing to
            // decode it would only fail a perfectly good payment whose input
            // selection shifted under a concurrent reservation.
            const keyBindsToFirstInput =
                hasActionPayload && (
                    preparedData["encoding"] === Encoding.OP_RETURN ||
                    preparedData["encoding"] === Encoding.MULTISIGN
                )
            if (keyBindsToFirstInput && txidFirstInput != null){
                // psbt.txInputs[0].hash is the internal little-endian outpoint hash; copy
                // before reversing so the PSBT's own buffer is not mutated.
                const actualFirstTxid = Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex')
                if (actualFirstTxid !== txidFirstInput){
                    throw new OperationalError(
                        'INPUT_SELECTION_RACE',
                        'input selection raced a concurrent reservation: the obfuscation key is bound to an outpoint that is not the first input; retry the request',
                        { expectedFirstInput: txidFirstInput, actualFirstInput: actualFirstTxid }
                    )
                }
            }
        }

        // Reject a caller-supplied absolute fee whose effective rate exceeds the
        // fee-rate cap for a transaction of this estimated size. Unlike feePerKb
        // (clamped above), an explicit fee is an exact amount the caller believes
        // they are paying. Silently lowering it would change what they sign, so
        // refuse loudly instead. Without this, fee values up to the gross
        // validator limit drain every selected input into miner fee.
        if (fee != null && fee !== false && capFeePerBytes != null){
            const maxFeeSatoshis = Math.max(this.dustAmount, Math.ceil(estimatedTxSize * capFeePerBytes * SATOSHI_UNIT))
            if (estimatedFee > maxFeeSatoshis){
                throw new RangeError(`fee ${estimatedFee} exceeds the maximum allowed ${maxFeeSatoshis} satoshis for a ~${estimatedTxSize}-byte transaction (fee-rate cap)`)
            }
        }

        // Absolute burn backstop that holds even when the operator disables the
        // rate cap (capFeePerBytes == null) and even when a change address is
        // supplied (which skips the burn guard below). An explicit fee above 100x
        // the node-derived fair fee for this size is almost certainly an error that
        // would drain every selected input to the miner, so refuse it. 100x matches
        // the default MAX_FEE_RATE_MULTIPLIER, so default deployments are unaffected.
        //
        // The fair-fee reference is the NODE's rate (nodeFeePerBytes), never the
        // caller-supplied feePerKb: deriving the ceiling from feePerBytes let a
        // caller inflate feePerKb to lift the ceiling with it, bypassing the
        // backstop entirely whenever the rate cap was disabled. feePerBytes is
        // used only as a last resort when the node can produce neither an
        // estimate nor a relayfee (same graceful degradation as the relative
        // cap, and the caller cannot cause that condition).
        if (fee != null && fee !== false){
            const referenceFeePerBytes = nodeFeePerBytes != null ? nodeFeePerBytes : feePerBytes
            if (referenceFeePerBytes != null){
                const fairFee = Math.ceil(estimatedTxSize * referenceFeePerBytes * SATOSHI_UNIT)
                const hardCeiling = Math.max(this.dustAmount, fairFee * 100)
                if (estimatedFee > hardCeiling){
                    throw new RangeError(`fee ${estimatedFee} exceeds 100x the estimated fair fee (${fairFee} satoshis) for a ~${estimatedTxSize}-byte transaction`)
                }
            }
        }

        if (estimatedFee < this.dustAmount){
            estimatedFee = this.dustAmount
        }

        // Validate the fee BEFORE the BigInt conversion below: a NaN/Infinity
        // fee would previously surface via the Number.isFinite(changeSatoshis)
        // check, but BigInt(estimatedFee) throws an opaque error on those.
        if (!Number.isFinite(estimatedFee) || !Number.isInteger(estimatedFee)) {
            throw new RangeError('Fee calculation produced invalid result. Check that all UTXO values and fees are valid integers.')
        }

        // Exact change math in BigInt: with a >2^53-1-sat input, Number
        // subtraction would round the change (and the caller would sign a
        // PSBT whose change is off by up to ~2 sats per 2^53).
        let changeSatoshis = inputSatoshis - outputSatoshis - BigInt(estimatedFee)

        // Reject a genuinely under-funded selection instead of returning an
        // unbroadcastable PSBT whose outputs exceed its inputs (the caller would
        // sign it and the network would reject it). Scoped to the funding/single
        // tx path: the reveal (p2shHash set) funds itself from phase-1 outputs
        // and never runs input selection, so inputSatoshis is 0 there by design
        // and a negative "change" is expected and harmless.
        if (!p2shHash && changeSatoshis < 0) {
            const required = outputSatoshis + BigInt(estimatedFee)
            throw new OperationalError(
                'INSUFFICIENT_FUNDS',
                `insufficient funds: selected inputs total ${inputSatoshis} but ${required} is required (outputs ${outputSatoshis} + fee ${estimatedFee})`,
                { required: jsonSafeSat(required), available: jsonSafeSat(inputSatoshis), outputs: jsonSafeSat(outputSatoshis), fee: estimatedFee }
            )
        }

        if ((changeSatoshis > this.dustAmount) && !change) {
            throw new OperationalError('CHANGE_ADDRESS_REQUIRED', 'Transaction would burn significant satoshis as fees. Please provide a change address.')
        }

        if ((changeSatoshis > 0) && (change)) {
            // Only emit change at or above the per-coin dust threshold
            // (this.dustAmount, the same constant the burn guard above keys on).
            // Change of 1..dust-1 sats is an unspendable, non-standard output
            // that makes the whole transaction unbroadcastable, so fold it into
            // the miner fee (leave it unclaimed) rather than emit it.
            if (changeSatoshis >= this.dustAmount) {
                psbt.addOutput({
                    address: change,
                    value: asSatValue(changeSatoshis)
                })
            }
        }

        // A P2WSH reveal that spends a single data chunk is just 1 input + 1
        // OP_RETURN output: 71 stripped (non-witness) bytes, which is BELOW the
        // relay floor on every chain we support. The floor is a POLICY constant
        // (Bitcoin Core's MIN_STANDARD_TX_NONWITNESS_SIZE = 82, Litecoin ~85),
        // NOT the 65-byte CONSENSUS minimum that guards the 64-byte-transaction
        // CVE. coins/BTC.js carried that consensus 65 until 2026-07-31, so this
        // pad never fired on Bitcoin and a single-chunk P2WSH reveal was
        // unbroadcastable there (measured live: 71 stripped bytes rejected
        // "tx-size-small", 82 accepted). Corrected to 82 with the consensus pin
        // regenerated across every repo vendoring BTC.js.
        //
        // The payload lives in the witness and does not count toward stripped
        // size, so this shape stays small however large the file is. Lift the
        // reveal over the chain's floor with one
        // small payment output back to the caller's own address. A second
        // OP_RETURN would be non-standard (multi-op-return), so we cannot pad
        // with that. The funding tx already over-funded this reveal by one dust
        // (see the P2WSH funding branch) so the output's value is available.
        let strippedFloor = this.network.minStandardTxNonWitnessSize
        if (p2shHash && preparedData["encoding"] === Encoding.P2WSH && strippedFloor){
            let padAddress = change || resolveCallerAddress(pubkey, this.network)
            if (padAddress && this.strippedTxSize(psbt) < strippedFloor){
                psbt.addOutput({
                    address: padAddress,
                    value: this.dustAmount
                })
            }
        }

        // Envelope reveal construction. Runs only on the
        // TAPROOT funding path, after input selection and change, so the commit
        // transaction is final in shape and its unsigned txid is the txid the
        // network will see (segwit-only inputs, enforced above).
        let revealPsbt = null
        let envelopeResult = null
        if (envelopeContext){
            // Every commit input is signed SIGHASH_ALL. Attribution rides
            // the commit's ins[0]; ANYONECANPAY-style signing would make index 0
            // third-party-insertable in a replacement. The PSBT field makes the
            // requirement explicit to whatever signs it.
            for (let i = 0; i < psbt.inputCount; i++){
                psbt.updateInput(i, { sighashType: bitcoin.Transaction.SIGHASH_ALL })
            }

            const commitTx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
            const commitTxid = commitTx.getId()
            // The envelope commit output is emitted first, so this is vout 0 by
            // construction; located by script rather than assumed, so a future
            // emission-order change cannot silently strand the reveal.
            const commitVout = commitTx.outs.findIndex(o => o.script.equals(envelopeContext.commitPayment.output))

            // Control block for the script-path spend: single-leaf tree, no
            // merkle path, 33 bytes (leaf version + parity bit, then the
            // internal key). Derived from the SAME payment object that built
            // the commit output, so it cannot drift from what was committed.
            const revealPayment = bitcoin.payments.p2tr({
                internalPubkey: envelopeContext.internalPubkey,
                scriptTree: { output: envelopeContext.envelopeScript },
                redeem: { output: envelopeContext.envelopeScript, redeemVersion: TAPROOT_LEAF_VERSION },
                network: this.network
            })
            const controlBlock = revealPayment.witness[revealPayment.witness.length - 1]

            revealPsbt = new bitcoin.Psbt({ network: this.network })
            // Reveal input 0 MUST be the commit outpoint; the decoder's
            // recognition and attribution assume it. RBF preference mirrors the
            // commit (the sequence toggle is the shipped replacement mechanism).
            revealPsbt.addInput({
                hash: commitTxid,
                index: commitVout,
                sequence: utxoSequence,
                witnessUtxo: {
                    script: envelopeContext.commitPayment.output,
                    value: envelopeContext.commitValue
                },
                tapInternalKey: envelopeContext.internalPubkey,
                tapLeafScript: [{
                    leafVersion: TAPROOT_LEAF_VERSION,
                    script: envelopeContext.envelopeScript,
                    controlBlock
                }]
            })
            // Change back to the caller: the commit value minus the reveal's
            // prefunded fee (and minus the floor pad's dust when present) is
            // exactly the dust floor by construction; it exists because the
            // reveal must carry an output and it doubles as the CPFP handle.
            const revealChangeValue = envelopeContext.commitValue
                - envelopeContext.revealFee
                - (envelopeContext.revealPadNeeded ? this.dustAmount : 0)
            revealPsbt.addOutput({
                address: envelopeContext.revealChangeAddress,
                value: revealChangeValue
            })
            if (envelopeContext.revealPadNeeded){
                revealPsbt.addOutput({
                    address: envelopeContext.revealChangeAddress,
                    value: this.dustAmount
                })
            }

            envelopeResult = {
                commitTxid,
                commitVout,
                commitValue: envelopeContext.commitValue,
                commitAddress: envelopeContext.commitPayment.address,
                internalPubkey: envelopeContext.internalPubkey.toString('hex'),
                tapleafHash: envelopeTapLeafHash(envelopeContext.envelopeScript).toString('hex'),
                controlBlock: controlBlock.toString('hex'),
                revealFee: envelopeContext.revealFee
            }
        }

        // Carrier scripts for the chunk lanes, so a client can VERIFY the
        // commit outputs it is about to sign instead of trusting them.
        //
        // An inline OP_RETURN action can be read straight back out of the PSBT
        // and cross-checked against what the caller asked for. A P2SH/P2WSH
        // action cannot: the payload lives in a redeem script that only exists
        // here, and the commit output is just its hash, so the client had no
        // way to tell a faithful encoding from a substituted one. That residual
        // trust is what this closes.
        //
        // These are the SAME compiled buffers that became the outputs above
        // (dataBufferArray IS the redeem-script array for these encodings), not
        // a re-derivation, so they cannot drift from what was actually built.
        // Publishing them reveals nothing secret: the script is disclosed on
        // chain the moment the reveal tx spends the output.
        //
        // The client's two checks are then: hash each script to a P2SH/P2WSH
        // output and require a match in the PSBT, and require the leading data
        // pushes to concatenate to the action it intended. Passing a forged
        // script means failing one or the other.
        let result = {"psbt":psbt,"encoding":preparedData["encoding"]}

        // Non-fatal advisory for the fee-payer; see rawDataOnlyPayload above. Additive
        // result field, the same shape `compression` already established, so a caller
        // that does not read it is unaffected.
        if (rawDataOnlyPayload){
            result.warnings = [{
                code: 'RAWDATA_ONLY_NOT_DECODED',
                message: 'rawData without data compiles to an OP_0-led payload that current ' +
                    'XChain decoders read as empty: the transaction will confirm and the fee ' +
                    'will be paid, but the payload will not be indexed as an ACTION'
            }]
        }

        // What compression actually did, reported rather than inferred. The
        // wallet has to show the REAL on-chain size, and with the
        // default ON a caller can no longer assume from its own request whether
        // the bytes were compressed: `reason` names why they were not.
        if (compressionResult){
            result.compression = {
                compressed:   compressionResult.compressed,
                rawLength:    compressionResult.rawLength,
                storedLength: compressionResult.storedLength,
                reason:       compressionResult.reason
            }
        }
        if (preparedData["encoding"] === Encoding.P2SH || preparedData["encoding"] === Encoding.P2WSH){
            result.carrierScripts = (preparedData["dataBufferArray"] || []).map(b => b.toString('hex'))
        }
        if (revealPsbt){
            // Two-tx response shape: the caller signs both,
            // then broadcasts commit followed by reveal. carrierScripts serves
            // the same verify-before-sign contract as the chunk lanes: hash the
            // script to the P2TR commit output and require a match, and require
            // the payload pushes to concatenate to the intended action.
            // `envelope` carries what the wallet must DURABLY PERSIST BEFORE
            // BROADCASTING the commit (plus its own internal-key derivation
            // path): lose the tapleaf hash and the key-path cancel tweak cannot
            // be reconstructed, stranding the funds.
            result.revealPsbt = revealPsbt
            result.carrierScripts = (preparedData["dataBufferArray"] || []).map(b => b.toString('hex'))
            result.envelope = envelopeResult
        }
        return result
    }

    /*
     * Size-aware encoding selection: "smallest footprint by default" as the
     * platform's behaviour rather than its option. Only reached when the caller
     * explicitly asked for Encoding.AUTO.
     *
     * @param {number} compiledLength  the compiled ACTION stream, AFTER compression
     * @param {string|null} compressedPubKey  required for the envelope's internal key
     * @param {object|null} options   { signerSupportsTapscript }
     */
    selectEncoding(compiledLength, compressedPubKey, options){
        const magicBytes = Buffer.from(MAGIC_WORD, 'utf8').length
        // Small payloads: one output, no reveal, nothing cheaper exists.
        if (compiledLength + magicBytes <= OP_RETURN_SIZE) return Encoding.OP_RETURN

        const segwit = this.network.supportsSegwit !== false

        // The envelope is ~2x cheaper per byte than P2WSH and replaces ~820
        // chunk outputs per 390 KB, so it wins whenever it is available. Two
        // conditions, both fail-closed:
        //
        //  - the network must have Taproot at all (DOGE never does);
        //  - the SIGNER must be able to produce a tapscript script-path
        //    signature. This defaults to NO and must be affirmed by the caller.
        //    The reveal has to be signable BEFORE the commit is broadcast;
        //    picking the envelope for a signer that cannot spend it does not
        //    produce an error message, it produces stranded funds. Hardware
        //    signers are the live case: the wallet's Trezor integration cannot
        //    sign the leaf today, so those accounts must land on P2WSH.
        const tapscriptSigner = !!(options && options.signerSupportsTapscript)
        if (segwit && tapscriptSigner && compressedPubKey) return Encoding.TAPROOT

        // P2WSH carries 476 bytes per chunk against MULTISIGN's 60, so it is the
        // segwit fallback. On a non-segwit chain P2SH is the same 476-byte lane
        // and is therefore preferred over MULTISIGN there too: AUTO never
        // selects the worst-density carrier, which is what makes MULTISIGN an
        // explicit-request-only lane from here on.
        if (segwit) return Encoding.P2WSH
        return Encoding.P2SH
    }

    // Stripped (non-witness) serialized byte count of a PSBT's underlying tx.
    // This is the size a node measures against its MIN_STANDARD_TX_NONWITNESS_SIZE
    // relay floor. P2WSH reveal inputs carry an empty scriptSig (all data lives in
    // the witness), so each contributes a fixed 41 non-witness bytes: 36-byte
    // outpoint + 1-byte empty-scriptSig length + 4-byte sequence.
    strippedTxSize(psbt){
        const varIntSize = (n) => n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9
        let size = 4 + 4 // version + locktime
        size = size + varIntSize(psbt.txInputs.length) + (41 * psbt.txInputs.length)
        size = size + varIntSize(psbt.txOutputs.length)
        for (let out of psbt.txOutputs){
            size = size + 8 + varIntSize(out.script.length) + out.script.length
        }
        return size
    }

    estimateSpendingP2shTx(redeemData){
        // Per-chunk embedded value sized to cover the spending tx's worst
        // case at 1 sat/vbyte. Includes tx overhead, the OP_RETURN marker
        // output, the P2SH input bringing this chunk's redeem script (sig +
        // compressed pubkey + redeem script push; see estimateP2shInputWithRedeem),
        // plus a small safety margin to absorb DER signature length jitter so the
        // broadcast never lands fractionally under the node's min relay fee floor.
        let sizeEstimated =
            10 // 4 version + 1 inputs count + 1 outputs count + 4 locktime
            + TxSizeEstimator.estimateP2shInputWithRedeem(redeemData)
            + TxSizeEstimator.estimateOpReturnOutput(Buffer.concat([
                Buffer.from(MAGIC_WORD,'utf8'),
                Buffer.from("p2sh",'utf8')
            ]))
            + 8 // safety margin for DER-sig length jitter (sig push assumes 72B)

        return sizeEstimated
    }

    estimateSpendingP2wshTx(witnessData){
        // Per-chunk embedded value sized to cover the P2WSH reveal tx's worst
        // case at 1 sat/vbyte. A native-segwit input keeps its scriptSig empty
        // and carries the reveal payload (sig + compressed pubkey + witness
        // script) in the witness, which is weight-1 (i.e. ÷4 toward vbytes).
        // That makes a P2WSH reveal materially cheaper than the equivalent P2SH
        // reveal: sizing it with estimateSpendingP2shTx would over-fund ~4x.
        // compactSize, not compiledPushSize: a witness stack item is length-
        // prefixed by a varint on the wire, it is not a push inside a script.
        // The two disagree in two bands and the old script-push model was wrong
        // in both: 76..252 it over-funded by a byte, and 253..255 it UNDER-funded
        // by a byte (OP_PUSHDATA1 is 2 bytes there, the varint is 3).
        let witnessScriptPrefix = compactSizeLen(witnessData.length)
        // Witness stack (weight 1): item count + sig item (1+72) + pubkey item
        // (1+33) + witness-script item prefix + script bytes, plus the segwit
        // marker+flag (2) which are also weight 1. The 72- and 33-byte items are
        // both under 253, so their compactSize prefix is the literal 1 below.
        let witnessBytes = 2                                    // marker + flag
            + 1                                                 // witness stack item count
            + (1 + 72)                                          // sig item
            + (1 + 33)                                          // compressed pubkey item
            + (witnessScriptPrefix + witnessData.length)        // witness script prefix + bytes

        // Non-witness (weight 4) bytes: tx overhead + the empty-scriptSig input
        // outpoint + the OP_RETURN marker output.
        let nonWitnessBytes =
            10 // 4 version + 1 inputs count + 1 outputs count + 4 locktime
            + (36 + 1 + 4) // outpoint(36) + empty scriptSig len(1) + sequence(4)
            + TxSizeEstimator.estimateOpReturnOutput(Buffer.concat([
                Buffer.from(MAGIC_WORD,'utf8'),
                Buffer.from("p2wsh",'utf8')
            ]))

        // A single-chunk reveal's stripped size (71 B) is below Litecoin's
        // tx-size-small floor, so the reveal builder pads it up to the chain's
        // minStandardTxNonWitnessSize with one extra output. Reflect that padded
        // stripped size here so the fee estimate covers the larger reveal. (In
        // normal fee regimes the dust floor dominates the embedded value, but
        // this keeps the estimate honest on high-fee chains.)
        let strippedFloor = this.network.minStandardTxNonWitnessSize
        if (strippedFloor && nonWitnessBytes < strippedFloor){
            nonWitnessBytes = strippedFloor
        }

        // vsize = ceil(total weight / 4) = nonWitnessBytes + ceil(witnessBytes/4)
        let sizeEstimated = nonWitnessBytes
            + Math.ceil(witnessBytes / 4)
            + 8 // safety margin for DER-sig length jitter (sig push assumes 72B)

        return sizeEstimated
    }

    // Key-path cancel of an UNREVEALED envelope commit:
    // sweeps the commit output back to the caller before any reveal exists. By
    // contract this must be buildable from the wallet's PERSISTED RECOVERY
    // RECORD ALONE ({commit outpoint, internal key derivation path, tapleaf
    // hash} plus the commit value), surviving a crash between commit and
    // reveal: nothing here re-derives from the envelope payload, and the P2TR
    // scriptPubKey is reconstructed from internal key + merkle root (the
    // tapleaf hash IS the merkle root of the single-leaf tree). The returned
    // PSBT carries tapInternalKey + tapMerkleRoot so the signer can compute
    // the BIP341 tweak; it conflicts with the reveal by construction (same
    // outpoint) and the wallet treats it as a replacement of the reveal.
    async createEnvelopeCancelTransaction({ commitTxid, commitVout, commitValue, internalPubkey, tapleafHash, destination, feePerKb = null, replacebyfee = false } = {}){
        if (typeof commitTxid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(commitTxid)) {
            throw new TypeError('commitTxid must be a 64-character hex string')
        }
        if (!Number.isInteger(commitVout) || commitVout < 0) {
            throw new TypeError('commitVout must be a non-negative integer')
        }
        const value = parseSatoshiAmount(commitValue, 'commitValue')
        // Accept the 33-byte compressed form (what create_tx took) or the
        // 32-byte x-only form (what the recovery record may hold).
        let internalKeyBuf
        if (typeof internalPubkey === 'string' && /^(02|03)[0-9a-fA-F]{64}$/.test(internalPubkey)) {
            internalKeyBuf = Buffer.from(internalPubkey, 'hex').subarray(1)
        } else if (typeof internalPubkey === 'string' && /^[0-9a-fA-F]{64}$/.test(internalPubkey)) {
            internalKeyBuf = Buffer.from(internalPubkey, 'hex')
        } else {
            throw new TypeError('internalPubkey must be a 66-character compressed or 64-character x-only pubkey hex string')
        }
        if (typeof tapleafHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(tapleafHash)) {
            throw new TypeError('tapleafHash must be a 64-character hex string')
        }
        // validateAddress, not a local non-empty check: this is the one create
        // path api.js does not route through validateAll, so without it the
        // 100-char cap every other address field gets is missing here and an
        // unbounded string reaches bs58check (quadratic) and psbt.addOutput.
        validateAddress(destination, 'destination')
        if (this.network.supportsSegwit === false) {
            throw new TypeError('TAPROOT encoding is not supported on this network (no segwit support)')
        }
        // Same money/boolean guards create_tx gets through validateAll, so both
        // create paths classify identical bad input identically (-32602). Left
        // uncoerced, a non-numeric feePerKb becomes NaN, slips past both dust
        // comparisons (every NaN comparison is false) and surfaces as an opaque
        // -32603; and the JSON string "false" is truthy, silently arming RBF.
        const feeRatePerKb = validateFeePerKb(feePerKb)
        const rbfArmed     = validateOptionalBoolean(replacebyfee, 'replacebyfee') === true
        ensureEccLib()
        const tapleafHashBuf = Buffer.from(tapleafHash, 'hex')

        // Fee-rate resolution with the same drain guards as createTransaction,
        // in miniature: the caller rate is clamped to the tighter of the
        // absolute MAX_FEE_RATE_KB cap and the relative multiplier x the node's
        // own estimate. A cancel sweeps a prefund that scales with payload size
        // and fee rate, so an unbounded rate here is a real burn surface.
        let feePerBytes
        let nodeFeePerBytes = null
        if (feeRatePerKb){
            feePerBytes = feeRatePerKb / 1000 / SATOSHI_UNIT
            try {
                nodeFeePerBytes = await this.connector.getFeePerKilobyte(1) / 1000
            } catch (err) {
                console.warn('Envelope-cancel relative fee cap skipped: node fee estimate unavailable:', err.message)
            }
        } else {
            feePerBytes = await this.connector.getFeePerKilobyte(1) / 1000
            nodeFeePerBytes = feePerBytes
        }
        let capFeePerBytes = this.maxFeePerBytes
        if (this.maxFeeRateMultiplier && nodeFeePerBytes != null){
            const relativeCap = nodeFeePerBytes * this.maxFeeRateMultiplier
            capFeePerBytes = (capFeePerBytes != null) ? Math.min(capFeePerBytes, relativeCap) : relativeCap
        }
        if (capFeePerBytes != null && feePerBytes > capFeePerBytes){
            feePerBytes = capFeePerBytes
        }

        const p2trPayment = bitcoin.payments.p2tr({
            internalPubkey: internalKeyBuf,
            hash: tapleafHashBuf,
            network: this.network
        })

        // vsize: 10 tx overhead + 58 key-path input (41 stripped + witness) +
        // destination output + 2 rounding slack; padded to the chain's
        // stripped-size relay floor exactly like the reveal (the key-path
        // witness does not count toward stripped size either).
        const destOutBytes = TxSizeEstimator.estimateOutputSizeForAddress(destination, this.network)
        const cancelStrippedFloor = this.network.minStandardTxNonWitnessSize
        const padNeeded = !!(cancelStrippedFloor && (10 + 41 + destOutBytes) < cancelStrippedFloor)
        let strippedBytes = 10 + 41 + destOutBytes + (padNeeded ? destOutBytes : 0)
        if (cancelStrippedFloor && strippedBytes < cancelStrippedFloor){
            strippedBytes = cancelStrippedFloor
        }
        const cancelVsize = strippedBytes + Math.ceil((2 + 1 + 1 + 65) / 4) + 2
        let cancelFee = Math.trunc(cancelVsize * feePerBytes * SATOSHI_UNIT)
        if (cancelFee < this.dustAmount){
            cancelFee = this.dustAmount
        }

        const sweepValue = value - cancelFee - (padNeeded ? this.dustAmount : 0)
        if (sweepValue < this.dustAmount){
            throw new OperationalError(
                'ENVELOPE_CANCEL_BELOW_DUST',
                `cancel would sweep ${sweepValue} satoshis (commit value ${value} minus fee ${cancelFee}${padNeeded ? ' minus floor pad' : ''}), below the dust floor (${this.dustAmount}); spend it via the reveal or CPFP instead`,
                { commitValue: value, fee: cancelFee, sweepValue }
            )
        }

        const psbt = new bitcoin.Psbt({ network: this.network })
        psbt.addInput({
            hash: commitTxid,
            index: commitVout,
            sequence: (rbfArmed ? 0x00000001 : 0xffffffff),
            witnessUtxo: {
                script: p2trPayment.output,
                value: value
            },
            tapInternalKey: internalKeyBuf,
            tapMerkleRoot: tapleafHashBuf
        })
        psbt.addOutput({ address: destination, value: sweepValue })
        if (padNeeded){
            psbt.addOutput({ address: destination, value: this.dustAmount })
        }

        return { psbt, encoding: Encoding.TAPROOT, cancel: true, fee: cancelFee }
    }
}

// The suggested-rate ceiling is exported so the estimate_fee endpoint quotes the
// same rate createTx would charge; a quote the builder then ignores is worse than
// no quote, because a wallet shows the user a fee that never applies.
XChainEncoder.suggestedFeeCeilingPerByte = suggestedFeeCeilingPerByte
XChainEncoder.isTestNetworkKey = isTestNetworkKey
XChainEncoder.DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE = DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE

module.exports = XChainEncoder