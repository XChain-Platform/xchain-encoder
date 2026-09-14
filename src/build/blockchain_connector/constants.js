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
 ********************************************************************/

const { getLogger } = require('../../observability');
const config = require('../../common/config');
const logger = getLogger();

const RPC_TIMEOUT = parseInt(config.NODE_RPC_TIMEOUT ?? '30000', 10)

// Absolute per-chain sanity ceiling (COIN/kB, the same unit estimatesmartfee
// returns) on the RAW non-regtest estimate before anything else sees it.
// getFeePerKilobyte's result is used two ways downstream: as the fee actually
// charged when a caller supplies none, AND as the anchor the caller-facing
// caps (MAX_FEE_RATE_KB, MAX_FEE_RATE_MULTIPLIER) derive their relative
// ceiling from - so a node returning a spiked or malformed estimate on
// testnet/mainnet lifts its own ceiling right along with it, and nothing
// downstream is positioned to catch that; those caps bound a CALLER-supplied
// rate, never the node's own report. Defaults are coin-scale, since fee rates
// run roughly 1000x higher in DOGE/kB than in BTC/kB or LTC/kB for an
// equivalent real-world cost; keyed off NETWORK's coin prefix
// (bitcoin-mainnet, litecoin-testnet, dogecoin-mainnet, ...). An unrecognized
// or missing prefix falls back to the bitcoin-scale default so an
// unconfigured deployment still gets a ceiling rather than none.
// FEE_ESTIMATE_SANITY_CEILING overrides in COIN/kB for every chain; a
// non-positive or unparseable value keeps the coin default (fail-safe: this
// guard can be tightened or loosened by env, never silently disabled).
const DEFAULT_FEE_ESTIMATE_SANITY_CEILING = {
    bitcoin: 0.01,   // 0.01 BTC/kB
    litecoin: 0.01,  // 0.01 LTC/kB
    dogecoin: 10,    // 10 DOGE/kB (~1000x the 0.01 DOGE/kB documented recommended rate)
}

module.exports = { logger, RPC_TIMEOUT, DEFAULT_FEE_ESTIMATE_SANITY_CEILING }
