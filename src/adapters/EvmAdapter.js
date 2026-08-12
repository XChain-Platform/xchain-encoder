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
 * XChain Encoder - EvmAdapter (PRE-WORK STUB)
 *
 * Stub of the EVM-family ChainAdapter. This is deliberately NON-FUNCTIONAL: it
 * declares the seam and the finality gate so the design is written down and
 * testable, but the transaction-building body is not built. Do NOT wire this to
 * a live route. The account-chains support design recommends building NOTHING
 * for EVM pre-launch; this stub is the "scope + finality gate" pre-work, not the
 * adapter build itself.
 *
 * When the adapter IS built (post-launch), each method below replaces
 * its throw with the EVM path noted in the comment. The finality gate is already
 * defined in evmFinality.js and surfaced here via getFinalityGate().
 *
 * Notable EVM-specific design decisions still OPEN before the body is written
 * (do not resolve them here):
 *   - Obfuscation key: derive from (sender_address || nonce), both known
 *     pre-signing and recoverable on-chain. deriveObfuscationKey() is the
 *     home for that, but the scheme must be decided and written into the protocol
 *     reference first, so it stays a throw.
 *   - Data carrier: calldata to a canonical sink vs self-send.
 *   - Address canonicalization: EIP-55 vs lowercase before the ledger.
 *
 ********************************************************************/

const { ChainAdapter, AdapterNotImplementedError } = require('./ChainAdapter');
const evmFinality = require('./evmFinality');

class EvmAdapter extends ChainAdapter {
    // `chain` is an EVM chain key present in evmFinality.EVM_FINALITY (e.g. 'ETH',
    // 'BASE'). Validated at construction so an unknown chain fails immediately
    // rather than at first gate check. Defaults to the primary L2 target.
    constructor(chain){
        super('evm');
        this.chain = String(chain || evmFinality.PRIMARY_L2_TARGET).toUpperCase();
        // Throws for an unknown chain; also caches the descriptor.
        this.finalityGate = evmFinality.finalityGate(this.chain);
    }

    // The finality/confirmation gate for THIS chain. Safe to
    // call today; this is the piece of pre-work that had to exist before an
    // adapter build. Returns the descriptor from evmFinality.js.
    getFinalityGate(){
        return this.finalityGate;
    }

    // Guard against THE L2 TRAP: true only when counting this chain's
    // own block depth is a sound finality signal (never for an L2).
    isL2BlockDepthSafe(){
        return evmFinality.isL2BlockDepthSafe(this.chain);
    }

    // The ChainAdapter surface below is unbuilt; each throw documents its EVM path.

    // EVM: build an unsigned EIP-1559 typed tx with the ACTION payload in
    // calldata (no 80-byte ceiling, no chunking), output is the typed tx (not a
    // PSBT). UTXO selection + utxo-tracker dependency drop out; replaced by
    // nonce + eth_getBalance.
    buildUnsignedTx(/* action, source, feeCtx */){
        throw new AdapterNotImplementedError(this.family, 'buildUnsignedTx');
    }

    // EVM: fee = gasLimit * gasPrice (EIP-1559 maxFeePerGas / priority tip).
    estimateFee(/* tx */){
        throw new AdapterNotImplementedError(this.family, 'estimateFee');
    }

    // EVM: source = tx.from, exact and one line (vs the UTXO first-input-owner
    // heuristic, the deepest UTXO assumption in the platform).
    resolveSource(/* tx */){
        throw new AdapterNotImplementedError(this.family, 'resolveSource');
    }

    // EVM: payload = calldata after the XCHN magic prefix.
    extractPayload(/* tx */){
        throw new AdapterNotImplementedError(this.family, 'extractPayload');
    }

    // EVM: key/IV from hash(sender_address || nonce). The scheme must be decided
    // and written into the protocol reference before this is built.
    deriveObfuscationKey(/* ctx */){
        throw new AdapterNotImplementedError(this.family, 'deriveObfuscationKey');
    }

    // EVM: poll via eth RPC (eth_getBlockByNumber). Reorg detection walks the
    // hash-linked parent chain like the decoder's existing walk-back.
    pollBlock(/* height */){
        throw new AdapterNotImplementedError(this.family, 'pollBlock');
    }

    detectReorg(/* fromHeight, knownHash */){
        throw new AdapterNotImplementedError(this.family, 'detectReorg');
    }
}

module.exports = { EvmAdapter };
