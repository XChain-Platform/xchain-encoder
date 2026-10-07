/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The one place this service reads process.env (CODE-STYLE.md, Module shape).
 *
 * Every name is a GETTER, not a value captured once at require time: the
 * prior call sites all read process.env live, per call, and several tests
 * set process.env mid-test expecting that. A plain object literal would
 * freeze every value at the first require and silently stop reacting, which
 * would be an unwanted behaviour change. A getter keeps the
 * read live while still confining the actual process.env access to this
 * file, which is the rule this file exists to satisfy.
 *
 * A name whose call site coerces the value (parseInt, parseFloat, a bound
 * check) keeps the RAW STRING here and coerces at the call site exactly as it
 * did before: the value moved, the type decision did not, so no behaviour
 * changed. A name with a single agreed default across every prior read
 * carries that default here instead.
 */
'use strict';

const config = {
    // codemod:env-entries
    get ENCODER_MAINTENANCE_FILE() { return process.env.ENCODER_MAINTENANCE_FILE; },
    get NETWORK() { return process.env.NETWORK || ''; },
    get XCHAIN_COMPRESSION_DEFAULT() { return process.env.XCHAIN_COMPRESSION_DEFAULT; },
    // Raw pass-throughs: the reading module still parses/bounds-checks these,
    // src/common/config.js only stops the process.env read happening outside it.
    get SUGGESTED_FEE_MAX_PER_VBYTE() { return process.env.SUGGESTED_FEE_MAX_PER_VBYTE; },
    get MAX_CPFP_UPLIFT_SAT() { return process.env.MAX_CPFP_UPLIFT_SAT; },
    get NODE_RPC_TIMEOUT() { return process.env.NODE_RPC_TIMEOUT; },
    get FEE_NO_ESTIMATE_RELAY_MULTIPLIER() { return process.env.FEE_NO_ESTIMATE_RELAY_MULTIPLIER; },
    get FEE_ESTIMATE_SANITY_CEILING() { return process.env.FEE_ESTIMATE_SANITY_CEILING; },
    // Deploy-manifest replica declaration; see src/server/single_instance_guard.js.
    get ENCODER_REPLICAS() { return process.env.ENCODER_REPLICAS; },
    // src/server/single_instance_guard.js's real-environment defaults (its `env`
    // parameter defaults to this object; tests still inject their own).
    get ENCODER_INSTANCE_LOCK_FILE() { return process.env.ENCODER_INSTANCE_LOCK_FILE; },
    get ENCODER_API_PORT() { return process.env.ENCODER_API_PORT; },
    // Unset-preserving network value for call sites that distinguish undefined from empty.
    get NETWORK_RAW() { return process.env.NETWORK; },
    get NODE_URL() { return process.env.NODE_URL; },
    get NODE_PORT() { return process.env.NODE_PORT; },
    get NODE_USER() { return process.env.NODE_USER; },
    get NODE_PASSWORD() { return process.env.NODE_PASSWORD; },
    get UTXO_TRACKER_URL() { return process.env.UTXO_TRACKER_URL; },
    get UTXO_TRACKER_API_PORT() { return process.env.UTXO_TRACKER_API_PORT; },
    get UTXO_TRACKER_PROFILE() { return process.env.UTXO_TRACKER_PROFILE; },
    get MAX_FEE_RATE_KB() { return process.env.MAX_FEE_RATE_KB; },
    get MAX_FEE_RATE_MULTIPLIER() { return process.env.MAX_FEE_RATE_MULTIPLIER; },
    get UTXO_TRACKER_MAX_LAG_BLOCKS() { return process.env.UTXO_TRACKER_MAX_LAG_BLOCKS; },
    get DUST_AMOUNT() { return process.env.DUST_AMOUNT; },
    get API_KEY() { return process.env.API_KEY; },
    get CORS_ORIGIN() { return process.env.CORS_ORIGIN; },
    get ENCODER_TRUST_PROXY() { return process.env.ENCODER_TRUST_PROXY; },
    get ENCODER_RATE_LIMIT_RPM() { return process.env.ENCODER_RATE_LIMIT_RPM; },
    get ENCODER_MAX_CONCURRENT_PROBES() { return process.env.ENCODER_MAX_CONCURRENT_PROBES; },
    get ENCODER_MAX_CONCURRENT_REQUESTS() { return process.env.ENCODER_MAX_CONCURRENT_REQUESTS; },
    get ENCODER_MAX_RPC_BATCH() { return process.env.ENCODER_MAX_RPC_BATCH; },
};

module.exports = config;
