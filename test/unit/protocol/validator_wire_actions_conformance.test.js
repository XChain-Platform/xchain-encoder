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
const local = require('../../../src/protocol/validator_wire_actions.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR || path.join(__dirname, '../../../../xchain-indexer');
const CANON = path.join(INDEXER_DIR, 'src', 'consensus', 'gates', 'validator_wire_actions.js');

function corpusNames(canon) {
    const names = new Set([...Object.keys(canon.VALIDATOR_WIRE_FORMATS), ...Object.keys(local.VALIDATOR_WIRE_FORMATS)]);
    for (const n of ['STAKE', 'UNSTAKE', 'DELEGATE', 'SLASH', 'SEND', 'toString', '__proto__']) names.add(n);
    return [...names];
}

const FORMATS = [undefined, '', ' ', '0', '1', '2', '3', '4', '5', '6', '7', '"1"', "'0'", ' 3 ',
    '01', '255', '256', '-1', '1.0', '0x1', 'x'];

function corpus(canon) {
    const out = ['', '|', 'ANCHOR|', '|0', null, undefined, 7, {}];
    for (const name of corpusNames(canon)) {
        for (const spelled of [name, name.toLowerCase(), ' ' + name + ' ']) {
            for (const f of FORMATS) out.push(f === undefined ? spelled : spelled + '|' + f + '|x');
        }
    }
    return out;
}

describe('validator wire actions conformance with the indexer consensus copy @regression', function () {
    before(function () {
        const indexer = siblingCheckout(__dirname, CANON);
        if (!indexer.usable)
            skipOrFail(this, indexer, 'the prelaunch validator wire-format conformance guard');
    });

    it('lists the same names and formats as xchain-indexer', function () {
        const canon = require(CANON);
        assert.deepStrictEqual(local.VALIDATOR_WIRE_FORMATS, canon.VALIDATOR_WIRE_FORMATS,
            'the encoder validator wire set drifted from xchain-indexer src/consensus/gates/validator_wire_actions.js');
        assert.strictEqual(local.ATTEST_BATCH_HEAD_VERSION, canon.ATTEST_BATCH_HEAD_VERSION);
        assert.strictEqual(local.ATTEST_BATCH_CONTINUATION_VERSION, canon.ATTEST_BATCH_CONTINUATION_VERSION);
    });

    it('returns the indexer verdict on every corpus input', function () {
        const canon = require(CANON);
        const inputs = corpus(canon);
        let admitted = 0;
        for (const data of inputs) {
            const expected = canon.isValidatorWireAction(data);
            assert.strictEqual(local.isValidatorWireAction(data), expected,
                'encoder and indexer disagree on ' + JSON.stringify(data));
            if (expected) admitted++;
        }
        assert.ok(admitted > 0 && admitted < inputs.length, 'corpus admitted ' + admitted + ' of ' + inputs.length);
    });
});
