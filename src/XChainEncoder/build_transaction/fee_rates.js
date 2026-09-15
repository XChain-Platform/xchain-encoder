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

const util = require('node:util');
const { logger, SATOSHI_UNIT } = require('../constants.js')
const { suggestedFeeCeilingPerByte, suggestedFeeCeilingFloorPerByte } = require('../fee_policy.js')

// The per-byte rate this build charges, the node rate the drain caps anchor
// to, the effective cap, and the dust floor, settled in that order.
async function resolveFeeRates(build){
    let { feePerKb } = build
    let feePerBytes = null
    let nodeFeePerBytes = null
    Object.assign(build, { feePerBytes, nodeFeePerBytes })
    if (feePerKb){
        await useCallerFeeRate.call(this, build)
    } else {
        await useNodeFeeRate.call(this, build)
    }
    await anchorRelayFeeRate.call(this, build)
    applyFeeCapAndDustFloor.call(this, build)
}

async function useCallerFeeRate(build){
    let { feePerKb, feePerBytes, nodeFeePerBytes } = build
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
        logger.warn(util.format('Relative fee cap skipped: node fee estimate unavailable:', err.message))
    }
    Object.assign(build, { feePerBytes, nodeFeePerBytes })
}

async function useNodeFeeRate(build){
    let { feePerBytes, nodeFeePerBytes } = build
    feePerBytes = await this.connector.getFeePerKilobyte(1)/1000 //Highest fee. In bitcoin context every kilobyte is 1000 bytes
    nodeFeePerBytes = feePerBytes
    // Clamp only the rate chosen ON THE CALLER'S BEHALF, and only on a test
    // chain. nodeFeePerBytes keeps the raw estimate so the fee-drain caps
    // below still anchor to what the node actually reported.
    let suggestedCap = suggestedFeeCeilingPerByte(this.networkKey, SATOSHI_UNIT)
    if (suggestedCap != null && feePerBytes > suggestedCap){
        // Never clamp below what the node will relay (see
        // suggestedFeeCeilingFloorPerByte); the floor is coin-correct
        // because it comes from the node, where the ceiling constant is not.
        try {
            const info = await this.connector.getNetworkInfo()
            const floor = suggestedFeeCeilingFloorPerByte(info && info.relayfee)
            if (floor != null && floor > suggestedCap) suggestedCap = floor
        } catch (err) {
            logger.warn(util.format('Suggested-fee ceiling relayfee floor unavailable; using the configured ceiling:', err.message))
        }
    }
    // Compare with a relative epsilon. Both sides are coin-per-byte floats
    // derived by dividing by 1000 and by SATOSHI_UNIT, so a ceiling that
    // EQUALS the node rate (the ordinary case on a DOGE test chain, where the
    // relay-derived floor and the node rate are both ten times relayfee) can
    // land one ULP above it and clamp the value to itself, logging a ceiling
    // breach that did not happen. A real breach is never this close.
    if (suggestedCap != null && feePerBytes > suggestedCap * (1 + 1e-12)){
        if (!this._suggestedFeeClampWarned){
            this._suggestedFeeClampWarned = true
            logger.warn(`Suggested fee rate ${Math.round(feePerBytes * SATOSHI_UNIT)} per vByte exceeds the ` +
                `test-chain ceiling; using ${Math.round(suggestedCap * SATOSHI_UNIT)} per vByte. ` +
                `Set SUGGESTED_FEE_MAX_PER_VBYTE to change or 0 to disable.`)
        }
        feePerBytes = suggestedCap
    }
    Object.assign(build, { feePerBytes, nodeFeePerBytes })
}

async function anchorRelayFeeRate(build){
    let { nodeFeePerBytes } = build
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
            logger.warn(util.format('Fee cap relayfee-anchor fallback failed; feePerKb cap disabled this build:', err.message));
        }
    }
    Object.assign(build, { nodeFeePerBytes })
}

function applyFeeCapAndDustFloor(build){
    let { feePerBytes, nodeFeePerBytes, dust } = build
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
        logger.warn(`Fee rate ${feePerBytes * 1000 * SATOSHI_UNIT} sat/kB exceeds the fee-rate cap, clamping to ${capFeePerBytes * 1000 * SATOSHI_UNIT} sat/kB`)
        feePerBytes = capFeePerBytes
    }
    
    // A caller dust may raise the floor for this build, never lower it: a leg under the
    // relay floor strands the caller's own reveal behind an unrelayable funding tx.
    let finalDust = this.outputFloor
    if (dust){
        finalDust = Math.max(Number(dust), this.outputFloor)
    }
    Object.assign(build, { capFeePerBytes, feePerBytes, finalDust })
}

module.exports = { resolveFeeRates }
