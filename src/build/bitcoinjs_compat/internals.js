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
 *
 * bitcoinjs-lib internal module resolution for Node and browserify.
 *
 ********************************************************************/

// Node follows bitcoinjs-lib's exported subpaths. Browserify 17 ignores the
// exports map, so its static branch points at the same shipped CJS modules.
const bufferutils = typeof module.require === 'function'
    ? module.require('bitcoinjs-lib/src/bufferutils')
    : require('bitcoinjs-lib/src/cjs/bufferutils.cjs');
const types = typeof module.require === 'function'
    ? module.require('bitcoinjs-lib/src/types')
    : require('bitcoinjs-lib/src/cjs/types.cjs');

module.exports = { bufferutils, types };
