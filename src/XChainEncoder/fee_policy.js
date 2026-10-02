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

const config = require('../common/config');
const { TEST_NETWORK_SUFFIXES, DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE, SUGGESTED_FEE_CEILING_RELAY_MULTIPLIER, DEFAULT_MAX_CPFP_UPLIFT_SAT, BURN_BACKSTOP_MULTIPLIER } = require('./constants.js')

function isTestNetworkKey(networkKey){
    const key = String(networkKey || '').toLowerCase()
    return TEST_NETWORK_SUFFIXES.some(s => key.endsWith(s))
}

// The suggested-rate ceiling in BTC/byte for `networkKey`, or null when this
// chain is unclamped. SUGGESTED_FEE_MAX_PER_VBYTE overrides the default; 0
// disables the clamp entirely.
function suggestedFeeCeilingPerByte(networkKey, satoshiUnit){
    const raw = parseFloat(config.SUGGESTED_FEE_MAX_PER_VBYTE)
    const perVbyte = Number.isFinite(raw) ? raw
        : (isTestNetworkKey(networkKey) ? DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE : 0)
    if (!(perVbyte > 0)) return null
    return perVbyte / satoshiUnit
}

function suggestedFeeCeilingFloorPerByte(relayfeePerKb){
    const relayfee = Number(relayfeePerKb)
    if (!(relayfee > 0)) return null
    return (relayfee / 1000) * SUGGESTED_FEE_CEILING_RELAY_MULTIPLIER
}

function maxCpfpUpliftSat(){
    const raw = parseFloat(config.MAX_CPFP_UPLIFT_SAT)
    const bound = Number.isFinite(raw) ? raw : DEFAULT_MAX_CPFP_UPLIFT_SAT
    return (bound > 0) ? Math.floor(bound) : 0
}

// Extra fee (base units) this transaction must pay for its whole mempool
// package to reach `targetFeePerBytes`, given the unconfirmed ancestors it
// inherits. Dogecoin Core 1.14 and every modern Core select for a block by
// ANCESTOR fee rate, so a child paying the target on its own bytes still sits
// unmined behind cheap parents: the live case was a batch paying 0.01017
// DOGE/kB whose 0.00313 DOGE/kB funding ancestors dragged the package to
// 0.00896, under the 0.01 inclusion floor. Returns 0 whenever the package
// already clears the target, so this only ever raises a fee.
// `ancestorFees` is the package's fee in COIN units (what a node's mempool RPC
// reports). `ancestorFeeSatoshis` is the same quantity already in base units and
// takes precedence when supplied: the two-phase prefund below knows the commit's
// fee exactly, as an integer, and routing it through a coin-unit float would
// re-introduce the representation error the epsilon shave exists to absorb.
function packageFeeUpliftSatoshis({ currentFee, txSize, ancestorSize, ancestorFees, ancestorFeeSatoshis, targetFeePerBytes, satoshiUnit }){
    if (!(targetFeePerBytes > 0)) return 0
    if (!Number.isFinite(txSize) || txSize <= 0) return 0
    const packageSize = Number(ancestorSize)
    if (!Number.isFinite(packageSize) || packageSize <= 0) return 0
    const ancestorFeeSat = (ancestorFeeSatoshis != null)
        ? Math.round(Number(ancestorFeeSatoshis))
        : Math.round(Number(ancestorFees) * satoshiUnit)
    if (!Number.isFinite(ancestorFeeSat) || ancestorFeeSat < 0) return 0
    // Rounding up a float product costs a whole base unit whenever the rate
    // carries binary representation error (0.01/1000 is not exact, so a 3000-byte
    // package at that rate lands on 3000000.0000000005). Shave a relative
    // epsilon, twelve orders of magnitude above the double's own error and far
    // below one base unit, so the ceiling reflects the arithmetic rather than the
    // representation.
    const packageFeeExact = (packageSize + txSize) * targetFeePerBytes * satoshiUnit
    const packageFeeNeeded = Math.ceil(packageFeeExact - Math.abs(packageFeeExact) * 1e-12)
    const uplift = (packageFeeNeeded - ancestorFeeSat) - currentFee
    return (uplift > 0) ? uplift : 0
}

// Bound a fee rate (coin per byte) by the operator cap, or by the fixed burn
// backstop when no cap is set, both anchored on the node rate or relayfee.
// Synchronous on purpose: the envelope cancel's suspension count is pinned.
function capCallerFeeRate({ feePerBytes, nodeFeePerBytes, relayFeePerKb, maxFeePerBytes, maxFeeRateMultiplier }){
    // Anchor on the relay floor when the node has no estimate, so no cap goes missing.
    const anchorFeePerBytes = nodeFeePerBytes != null ? nodeFeePerBytes
        : (relayFeePerKb > 0 ? relayFeePerKb / 1000 : null)
    // The operator cap: the tighter of MAX_FEE_RATE_KB and the relative multiplier.
    let capFeePerBytes = maxFeePerBytes
    if (maxFeeRateMultiplier && anchorFeePerBytes != null){
        const relativeCap = anchorFeePerBytes * maxFeeRateMultiplier
        capFeePerBytes = (capFeePerBytes != null) ? Math.min(capFeePerBytes, relativeCap) : relativeCap
    }
    // With both operator caps disabled, the burn backstop still bounds the rate.
    const backstopFeePerBytes = (capFeePerBytes == null && anchorFeePerBytes != null)
        ? anchorFeePerBytes * BURN_BACKSTOP_MULTIPLIER : null
    const ceiling = capFeePerBytes != null ? capFeePerBytes : backstopFeePerBytes
    const clamped = ceiling != null && feePerBytes > ceiling
    return { anchorFeePerBytes, capFeePerBytes, backstopFeePerBytes, clamped, feePerBytes: clamped ? ceiling : feePerBytes }
}

// The fee in base units for `vsize` bytes at `feePerBytes` (coin per byte),
// ROUNDED UP like the relay floor (ceil(size * perKb / 1000)): a truncated fee
// lands one unit under a floor the same rate clears. A whole per-kB rate
// divides exactly in BigInt, since fl(rate / 1e8) * 1e8 can fall one ULP short;
// a fractional rate takes the epsilon-shaved ceil above. A non-positive product
// keeps plain truncation.
function feeForVsize(vsize, feePerBytes, satoshiUnit){
    const exact = vsize * feePerBytes * satoshiUnit
    if (!(exact > 0)) return Math.trunc(exact)
    const ratePerKb = feePerBytes * 1000 * satoshiUnit
    const wholeRate = Math.round(ratePerKb)
    if (Number.isSafeInteger(vsize) && Number.isSafeInteger(wholeRate) &&
        Math.abs(ratePerKb - wholeRate) <= 1e-9 * Math.max(1, wholeRate)){
        return Number((BigInt(vsize) * BigInt(wholeRate) + 999n) / 1000n)
    }
    return Math.ceil(exact - Math.abs(exact) * 1e-12)
}

module.exports = { isTestNetworkKey, suggestedFeeCeilingPerByte, suggestedFeeCeilingFloorPerByte, maxCpfpUpliftSat, packageFeeUpliftSatoshis, capCallerFeeRate, feeForVsize }
