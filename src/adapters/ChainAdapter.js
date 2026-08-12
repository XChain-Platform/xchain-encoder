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
 * XChain Encoder - ChainAdapter interface (PRE-WORK STUB)
 *
 * The account-chains support design prescribes ONE implementation per chain
 * FAMILY behind a single interface, rather than scattering if(coin === 'ETH')
 * across the encoder/decoder/indexer. Today the platform is UTXO-only and has
 * no such seam; the existing PSBT path in XChainEncoder.js IS the (implicit)
 * UtxoAdapter. This declares the interface so the EVM pre-work stub has a real
 * contract to implement, and so a future UtxoAdapter refactor and any SvmAdapter
 * share one shape.
 *
 * Minimum adapter surface:
 *   buildUnsignedTx(action, source, feeCtx)   PSBT | EIP-1559 typed tx
 *   estimateFee(tx)                            sat/byte | gasLimit * gasPrice
 *   resolveSource(tx)                          ins[0] owner chase | tx.from
 *   extractPayload(tx)                         script carriers | calldata
 *   deriveObfuscationKey(ctx)                  first-input txid | sender||nonce
 *   pollBlock(height) / detectReorg(...)       bitcoind RPC | eth RPC
 *
 ********************************************************************/

// A caller-actionable "this adapter path is not built yet" signal. Distinct from
// a generic Error so a caller (and the unit tests) can assert on it precisely and
// so api.js could branch on it were an unbuilt adapter ever wired to a live route.
class AdapterNotImplementedError extends Error {
    constructor(family, method){
        super(family + ' adapter: ' + method + '() is not implemented (pre-work stub)');
        this.name = 'AdapterNotImplementedError';
        this.notImplemented = true;
        this.family = family;
        this.method = method;
    }
}

// Abstract base. Subclasses set `family` and override the surface. The base
// methods throw AdapterNotImplementedError so a partial subclass fails loudly
// at the exact unbuilt method instead of returning undefined.
class ChainAdapter {
    constructor(family){
        this.family = family || 'unknown';
    }

    buildUnsignedTx(/* action, source, feeCtx */){
        throw new AdapterNotImplementedError(this.family, 'buildUnsignedTx');
    }

    estimateFee(/* tx */){
        throw new AdapterNotImplementedError(this.family, 'estimateFee');
    }

    resolveSource(/* tx */){
        throw new AdapterNotImplementedError(this.family, 'resolveSource');
    }

    extractPayload(/* tx */){
        throw new AdapterNotImplementedError(this.family, 'extractPayload');
    }

    deriveObfuscationKey(/* ctx */){
        throw new AdapterNotImplementedError(this.family, 'deriveObfuscationKey');
    }

    pollBlock(/* height */){
        throw new AdapterNotImplementedError(this.family, 'pollBlock');
    }

    detectReorg(/* fromHeight, knownHash */){
        throw new AdapterNotImplementedError(this.family, 'detectReorg');
    }
}

module.exports = { ChainAdapter, AdapterNotImplementedError };
