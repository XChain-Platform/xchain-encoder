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

'use strict';

// Vendored byte-equal from xchain-documentation/protocol/constants.js.
// MAINNET HEIGHTS PULLED IN 2026-08-02 (operator decision): BTC 961000 ->
// 960850, LTC 3160000 -> 3153500, both ~6 hours out from a measured tip rather
// than 2 and 12 days. Pre-launch features do not wait on dates; the fleet
// already runs this code, so only the constant moves.
const ENVELOPE_RECOGNITION_ACTIVATION = {
    BTC:  { mainnet: 960850, testnet: 0, regtest: 0 },
    LTC:  { mainnet: 3153500, testnet: 0, regtest: 0 },
    DOGE: { mainnet: null, testnet: null, regtest: null },
};

module.exports = { ENVELOPE_RECOGNITION_ACTIVATION };
