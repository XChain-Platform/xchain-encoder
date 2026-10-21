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
 * 64-bit satoshi value bounds and narrowing shared by the patch parts.
 *
 ********************************************************************/

const MAX_U64 = 0xffffffffffffffffn
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER)

// Bounds-check a satoshi value that may be a Number or a BigInt, mirroring
// stock verifuint's error strings so callers relying on them keep working.
// Guard order is stock verifuint's, not a preference: non-number, negative,
// upper bound, fractional. Testing fractional first made -0.5 report a
// fractional component where stock reports a negative value, and converting to
// BigInt before the range check let +/-Infinity escape as a native BigInt
// RangeError instead of either stock string. Comparing before converting is
// what fixes both, and mixed Number/BigInt relational comparison is legal, so
// one pair of comparisons covers both accepted types (NaN fails both and falls
// to the fractional branch, exactly as stock does).
function verifyU64(value) {
    if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error('cannot write a non-number as a number')
    }
    if (value < 0) {
        throw new Error('specified a negative value for writing an unsigned value')
    }
    // Cap a Number at stock's 2^53-1, since past it the value is no longer exact; a BigInt
    // carries anything larger, up to the wire's 2^64-1.
    if (value > MAX_U64 || (typeof value === 'number' && value > Number.MAX_SAFE_INTEGER)) {
        throw new Error('RangeError: value out of range')
    }
    if (typeof value === 'number' && Math.floor(value) !== value) {
        throw new Error('value has a fractional component')
    }
    return BigInt(value)
}

// Number when exactly representable, BigInt above 2^53-1. Keeps every
// pre-patch caller seeing the same type it always saw.
function narrowU64(big) {
    return big <= MAX_SAFE_BIG ? Number(big) : big
}

module.exports = { MAX_U64, MAX_SAFE_BIG, verifyU64, narrowU64 }
