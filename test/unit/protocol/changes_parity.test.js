// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const path = require('path');
const { ENVELOPE_RECOGNITION_ACTIVATION } = require('../../../src/protocol/changes.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

describe('protocol changes parity with documentation canonical', function () {
    const CANON = path.join(
        __dirname,
        '../../../../xchain-documentation/protocol/constants.js'
    );

    before(function () {
        const docs = siblingCheckout(__dirname, CANON);
        if (!docs.usable)
            skipOrFail(this, docs, 'the canonical envelope-recognition activation guard');
    });

    it('matches the canonical envelope-recognition activation map', function () {
        const canonical = require(CANON).ENVELOPE_RECOGNITION_ACTIVATION;
        assert.deepStrictEqual(
            ENVELOPE_RECOGNITION_ACTIVATION,
            canonical,
            'encoder envelope-recognition activation map drifted from documentation canonical'
        );
    });
});
