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

const bitcoin = require('bitcoinjs-lib');
const config = require('../common/config');

// THE tracker-freshness classifier. Pure: it reads a `sync` object and a lag
// ceiling and returns a verdict; it never throws, logs, or touches a connector.
//
// It exists because the same verdict was written twice against two different
// endpoints and drifted: _buildTransaction read the `sync` sibling that get_utxos
// carries, api.js getServeReadiness() read getSyncStatus(), and each re-derived
// halted / over-lag / behind-node / mempool-ready with its own strict-equality
// chain. Both surfaces now call this, so a create_tx refusal and an unhealthy
// /status can no longer disagree about the same tracker.
//
// Fail-open is deliberate and narrow, NOT an oversight: a field that is absent
// (an older tracker predating the ce16bdd freshness surface, or one predating
// the halt/mempool markers) must not refuse every build in the fleet, so only an
// EXPLICIT negative refuses. `halted` refuses on === true; `synced` refuses on
// === false; `mempool_ready` refuses on === false; a non-numeric lag is unknown
// and bounds nothing. An entirely missing `sync` yields present:false and no code.
//
// Returns:
//   present       - a usable sync object was supplied
//   lag           - numeric lag, or null when the tracker did not report one
//   overLag       - lag is above maxLagBlocks
//   behindNode    - lag is negative, i.e. the tracker's committed tip sits ABOVE
//                   the node's, so its outputs live in orphaned blocks
//   halted        - tracker stopped polling on an unrecoverable reorg
//   mempoolReady  - mempool index has reconverged (true unless explicitly false)
//   syncedClaimed - the tracker's own positive `synced` assertion, truthy-tested.
//                   Readiness probes need this POSITIVE form (an omitted field is
//                   not an assertion of health), while the create_tx gate refuses
//                   only on the explicit negative; that asymmetry is the one real
//                   difference between the two surfaces and is now named instead
//                   of being buried in two `===` chains.
//   code          - null when nothing refuses, else the OperationalError code
//   message       - operator-facing refusal text, null when code is null
//   details       - error details payload, null when code is null
//
// Order matters: halted first (most specific physical cause), then staleness,
// then mempool readiness. An orphaned or lagging view also de-asserts
// mempool_ready (the tracker floors that field on the same negative lag), so
// checking readiness first would name mempool reconvergence for what is really a
// node reset.
function classifyTrackerFreshness(sync, maxLagBlocks){
    if (!sync || typeof sync !== 'object'){
        return {
            present: false, lag: null, overLag: false, behindNode: false,
            halted: false, mempoolReady: true, syncedClaimed: false,
            code: null, message: null, details: null
        }
    }
    // NaN is excluded explicitly: it is `typeof number`, so it passed the old check
    // and was then reported verbatim as the lag while answering every comparison
    // below with a silent false. Unknown is the honest verdict for it. Infinity is
    // NOT excluded: it compares, and it compares as unboundedly stale, which is
    // exactly the refusal a garbage lag should get.
    const lag = (typeof sync.lag === 'number' && !Number.isNaN(sync.lag)) ? sync.lag : null
    const overLag = (lag !== null) && (lag > maxLagBlocks)
    const behindNode = (lag !== null) && (lag < 0)
    const halted = sync.halted === true
    const mempoolReady = sync.mempool_ready !== false
    const syncedClaimed = !!sync.synced
    const heights = { lag, tracker_height: sync.tracker_height, node_height: sync.node_height }
    const verdict = {
        present: true, lag, overLag, behindNode, halted, mempoolReady, syncedClaimed,
        code: null, message: null, details: null
    }
    if (halted){
        verdict.code = 'UTXO_TRACKER_HALTED'
        verdict.message = `utxo-tracker is halted (${sync.halt_reason || 'unrecoverable reorg'}); ` +
            'refusing to select utxos from it'
        verdict.details = Object.assign({}, heights, { halt_reason: sync.halt_reason || null })
        return verdict
    }
    if (sync.synced === false || overLag || behindNode){
        verdict.code = 'UTXO_TRACKER_STALE'
        verdict.message = `utxo-tracker view is stale (lag ${lag === null ? 'unknown' : lag} blocks` +
            `${overLag ? `, exceeds ${maxLagBlocks}-block threshold` : ''}` +
            `${behindNode ? `, tracker is ahead of the node so its view is orphaned` : ''}); ` +
            'refusing to select utxos from it'
        verdict.details = heights
        return verdict
    }
    if (!mempoolReady){
        verdict.code = 'UTXO_TRACKER_NOT_READY'
        verdict.message = 'utxo-tracker has not reconverged its mempool yet, so an already-spent ' +
            'confirmed output cannot be filtered; refusing to select utxos from it'
        verdict.details = heights
        return verdict
    }
    return verdict
}

// Resolve the 20-byte caller HASH160 that gates a P2SH/P2WSH chunk-lane reveal,
// from ANY caller identity a client passes, not just a base58 legacy address.
// The reveal tx that spends a chunk output must satisfy an ordinary P2PKH gate
// (OP_DUP OP_HASH160 <hash160> OP_EQUALVERIFY OP_CHECKSIG) with the SOURCE key,
// so the returned hash MUST equal HASH160(that pubkey). It is the same 20 bytes
// whichever identity form the caller sends:
//   - base58 P2PKH/P2SH address -> fromBase58Check().hash (legacy, unchanged)
//   - raw compressed/uncompressed pubkey hex -> crypto.hash160(pubkey)
//   - v0 bech32 P2WPKH address -> the witness program IS HASH160(pubkey)
// The decoder reads ONLY the leading data chunk (redeemScript[0]) and never this
// trailer hash, so this is compose-side only with NO consensus/wire surface.
// Before all three forms were supported, wallet flows that send a raw compressed
// pubkey and bech32 sources threw "Non-base58 character" here. That prevented
// large FILE, contract DEPLOY, validator UNSTAKE/claim, and cross-chain SWAP
// broadcasts from bech32-only venues.
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
// tracker's getUtxosFromAddress, and the dust-padding fallback below). Every
// wallet flow sends its source as a raw compressed pubkey hex in this `pubkey`
// param. Only a legacy caller or a pre-resolved value sends an address directly.
// Before this resolution step, getUtxosFromAddress(pubkey) handed
// address.toOutputScript a raw pubkey hex, which is not valid base58 or bech32,
// so it threw "<hex> has no matching Script" and every UTXO-tracker-backed
// compose, meaning every compose that did not pre-supply `utxos`, failed.
// Address-type choice for a bare pubkey: this network's default (P2WPKH when
// segwit-capable, else legacy P2PKH), matching the wallet's own default address
// type for each coin. A caller who actually spends from a different address type
// (P2SH-P2WPKH, taproot) must keep pre-supplying `utxos` or pass an explicit
// address. A bare pubkey is inherently address-type-ambiguous, and the network
// default is the best a single guess can do.
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

// Deployment default for transparent FILE compression. ON unless
// the operator turns it off for a staged rollout; read per call rather than
// cached so a restart is not required to change it.
function defaultCompressionEnabled(){
    const raw = config.XCHAIN_COMPRESSION_DEFAULT
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

module.exports = { classifyTrackerFreshness, resolveCallerHash160, resolveCallerAddress, defaultCompressionEnabled, assertRevealFundingTxMatches }
