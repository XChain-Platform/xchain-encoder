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
 * In-process compatibility patch for bitcoinjs-lib 7.
 *
 * bitcoinjs-lib 7 uses BigInt satoshi values and Uint8Array byte values. This
 * layer preserves the encoder's Number and Buffer-facing API while retaining
 * exact unsigned 64-bit values above Number.MAX_SAFE_INTEGER.
 *
 ********************************************************************/

require('./apply_bufferutils_patch/v7')

module.exports = require('bitcoinjs-lib/src/bufferutils')
