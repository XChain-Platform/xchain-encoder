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
 * XChain Encoder - EVM finality-gate constants (PRE-WORK STUB, )
 *
 * Account-chain (EVM) support pre-work. Per the account-chains support spec
 * (claude/reports/specs/account-chains-support-spec.md §7.5, §12) the ONE
 * EVM-specific safety decision before any adapter build is defining the
 * confirmation/finality GATE the federation must clear before it relays or
 * settles a cross-chain leg that ORIGINATED on an EVM chain. The rollback and
 * cross-chain retraction machinery already exists and is finality-model
 * agnostic; what is new for EVM is the gate, and the gate is values, not logic.
 *
 * These constants are DELIBERATELY not yet armed into any consensus hash
 * (coins/consensus_pin.js). They are exploratory pre-work so the finality model
 * is written down and testable before an adapter is committed. Arming a chain
 * for production is a separate coordinated bump that adds a <COIN>.js data file
 * to src/coins/ and a pin entry, exactly as documented in coins/index.js.
 *
 * THE L2 TRAP (spec §12): an L2's own block depth is NOT a safe finality signal.
 * Sequencer-level L2 state is reversible until the batch is posted to and final
 * on the L1. The gate for an L2 origin chain must therefore observe L1 batch
 * inclusion + L1 finality, NEVER a count of L2 blocks. isL2BlockDepthSafe()
 * exists so that trap is a named, testable guard rather than a comment.
 *
 ********************************************************************/

// Finality models the confirmation gate can operate in. UTXO chains (BTC/LTC/
// DOGE) use PROBABILISTIC-DEPTH today (count N buried blocks). EVM adds two.
const FINALITY_MODES = {
    // UTXO / PoW: gate on N confirmations of buried proof-of-work depth. Named
    // here for completeness; the existing UTXO coins carry it implicitly.
    PROBABILISTIC_DEPTH: 'probabilistic-depth',

    // PoS L1 (Ethereum): gate on the beacon-chain FINALIZED checkpoint (~2
    // epochs, 64 slots, ~12.8 min). This is arguably STRONGER than PoW depth
    // because it is economic-finality, not probabilistic. The gate queries the
    // node's `finalized` tag rather than counting blocks.
    L1_CHECKPOINT: 'l1-checkpoint',

    // Rollup L2 (Base / Arbitrum / Optimism): gate on the L2 batch being POSTED
    // to the settlement L1 AND that L1 batch transaction being final. Never on
    // L2 block depth (see THE L2 TRAP above).
    L1_DATA_POSTING: 'l1-data-posting',
};

// Per-chain finality-gate descriptors for the EVM family. `confirmations` is the
// integer depth for the existing hub confirmation-gate idiom (resolveConfirmations
// in coins/index.js) where a depth is meaningful; it is intentionally null for L2s
// because no L2 block depth is safe (the gate is a settlement-chain event, not a
// count). `finalityMode` is the load-bearing field.
const EVM_FINALITY = {
    // ── L1 Ethereum ─────────────────────────────────────────────────────────
    ETH: {
        chainId:        1,
        family:         'evm',
        tier:           'L1',
        finalityMode:   FINALITY_MODES.L1_CHECKPOINT,
        // Checkpoint finality window, expressed for documentation/telemetry.
        epochs:         2,
        slotsPerEpoch:  32,
        // Depth-equivalent floor (2 epochs of slots) for consumers that still
        // want an integer; the authoritative signal is the `finalized` tag.
        confirmations:  64,
        settlementChain: null,
        l2BlockDepthUnsafe: false,
        nativeDecimals: 18,
        armed:          false, // not in any consensus pin; pre-work only
    },

    // ── L2 rollups (spec recommends an L2 as the FIRST target; Base default) ──
    BASE: {
        chainId:        8453,
        family:         'evm',
        tier:           'L2',
        finalityMode:   FINALITY_MODES.L1_DATA_POSTING,
        settlementChain: 'ETH',
        confirmations:  null,           // no safe L2 block depth
        l2BlockDepthUnsafe: true,
        nativeDecimals: 18,
        armed:          false,
    },
    ARBITRUM: {
        chainId:        42161,
        family:         'evm',
        tier:           'L2',
        finalityMode:   FINALITY_MODES.L1_DATA_POSTING,
        settlementChain: 'ETH',
        confirmations:  null,
        l2BlockDepthUnsafe: true,
        nativeDecimals: 18,
        armed:          false,
    },
    OPTIMISM: {
        chainId:        10,
        family:         'evm',
        tier:           'L2',
        finalityMode:   FINALITY_MODES.L1_DATA_POSTING,
        settlementChain: 'ETH',
        confirmations:  null,
        l2BlockDepthUnsafe: true,
        nativeDecimals: 18,
        armed:          false,
    },
};

// Spec §11 recommendation: target one EVM L2 first, framed as bridgeless
// cross-chain reach. Base is the default first target.
const PRIMARY_L2_TARGET = 'BASE';

// Uppercase-normalized lookup. Throws on an unknown chain so a typo never
// silently degrades to an undefined (and thus unguarded) gate.
function finalityGate(chain){
    const key = String(chain || '').toUpperCase();
    const gate = EVM_FINALITY[key];
    if(!gate) throw new Error('No EVM finality gate defined for chain: ' + chain);
    return gate;
}

// THE L2 TRAP guard (spec §12). Returns true only when counting this chain's own
// block depth is a sound finality signal. False for every L2: their state is
// reversible until posted to and final on the settlement L1, so a gate that
// counts L2 blocks would settle the Bitcoin leg against reversible state.
function isL2BlockDepthSafe(chain){
    const gate = finalityGate(chain);
    return gate.tier === 'L1' && gate.finalityMode !== FINALITY_MODES.L1_DATA_POSTING;
}

// True when this chain's gate resolves against a SETTLEMENT chain's L1 events
// (batch posting + L1 finality) rather than the origin chain itself.
function requiresSettlementChainFinality(chain){
    const gate = finalityGate(chain);
    return gate.finalityMode === FINALITY_MODES.L1_DATA_POSTING;
}

module.exports = {
    FINALITY_MODES,
    EVM_FINALITY,
    PRIMARY_L2_TARGET,
    finalityGate,
    isL2BlockDepthSafe,
    requiresSettlementChainFinality,
};
