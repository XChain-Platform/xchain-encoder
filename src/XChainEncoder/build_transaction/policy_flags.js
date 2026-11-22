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
 **********************************************************************/

'use strict'

const { validateOptionalBoolean } = require('../../common/validator')

// createTransaction is also a public library entry, where no RPC validator
// runs first. Validate before any node request or reservation can occur.
// The builder reads these flags as `options && options.flag`, which reaches
// properties on arrays, functions and prototypes too, so every non-null
// options value is checked rather than only plain objects.
function checkPolicyFlags(build) {
    for (const key of ['replacebyfee', 'unconfirmed', 'attachPrevTx', 'compress']) {
        validateOptionalBoolean(build[key], key)
    }
    const options = build.options
    if (options !== null && options !== undefined) {
        for (const key of ['exactInputs', 'signerSupportsTapscript', 'twoStepEnvelope']) {
            validateOptionalBoolean(options[key], `options.${key}`)
        }
    }
}

module.exports = { checkPolicyFlags }
