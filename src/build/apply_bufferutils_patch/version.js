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
 * Which bitcoinjs-lib major is loaded (v7 ships valibot's SatoshiSchema).
 *
 ********************************************************************/

const bitcoinTypes = require('bitcoinjs-lib/src/types')

module.exports = { IS_BITCOINJS_V7: !!bitcoinTypes.SatoshiSchema }
