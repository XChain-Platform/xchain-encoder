// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Cross-repo ACTION-manifest conformance guard, encoder side.
// The encoder's validateActionName gate (src/validator.js) must reject
// exactly the leading ACTION tokens the decoder would reject, or it either
// blocks a name the decoder actually accepts (false-positive reject on a
// valid caller) or lets a name through that the decoder silently drops. The
// authoritative set lives in xchain-documentation/protocol/action-manifest.json
// and is vendored here byte-identically (mirroring
// xchain-decoder/test/fixtures/action-manifest.json). This guard asserts the
// encoder's local VALID_ACTION_NAMES/ACTION_ALIASES literals equal the
// manifest's wireDecoded slice + aliases, so drift between the encoder's
// pre-check and the decoder's actual arbiter fails loud instead of silently
// letting a rejected-elsewhere name back through.

const assert = require('assert');
const fs   = require('fs');
const path = require('path');
const v = require('../../src/validator.js');

const VENDORED = path.join(__dirname, '..', 'fixtures', 'action-manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));

function manifestSlice(flag) {
    return Object.entries(MANIFEST.actions).filter(([, val]) => val[flag]).map(([k]) => k).sort();
}

describe('ACTION manifest conformance: encoder validateActionName gate @regression', function () {
    it('VALID_ACTION_NAMES exactly equals the manifest wireDecoded slice (the decoder arbiter set)', function () {
        const expected = manifestSlice('wireDecoded');
        const actual = [...v.VALID_ACTION_NAMES].sort();
        const missing = expected.filter(a => !actual.includes(a)); // decoder decodes it, encoder gate would reject it
        const extra   = actual.filter(a => !expected.includes(a)); // encoder gate accepts it, decoder does not decode it
        assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
            'encoder VALID_ACTION_NAMES drifted from action-manifest.json wireDecoded set (== the decoder\'s own VALID_ACTION_NAMES). ' +
            'MISSING (decoder decodes, encoder gate would wrongly reject): ' + JSON.stringify(missing) +
            '. EXTRA (encoder gate accepts, decoder would drop): ' + JSON.stringify(extra) +
            '. Edit xchain-documentation/protocol/action-manifest.json + re-vendor, and update src/validator.js VALID_ACTION_NAMES to match xchain-decoder\'s.');
    });

    it('ACTION_ALIASES exactly equals the manifest aliases (and the decoder ACTION_ALIASES)', function () {
        const expected = MANIFEST.aliases;
        const actual = v.ACTION_ALIASES;
        assert.deepStrictEqual(actual, expected,
            'encoder ACTION_ALIASES drifted from action-manifest.json aliases / xchain-decoder ACTION_ALIASES. ' +
            'Keep src/validator.js ACTION_ALIASES byte-identical to xchain-decoder\'s.');
    });

    // IDENTITY: the vendored copy must match the canonical source (skip when the
    // sibling xchain-documentation is not checked out, matching the decoder's
    // own ActionManifestConformance convention).
    describe('byte-identity to canonical manifest', function () {
        const DOCS = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', 'xchain-documentation');
        const CANON = path.join(DOCS, 'protocol', 'action-manifest.json');
        before(function () { if (!fs.existsSync(CANON)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical action-manifest.json not found at ' + CANON); this.skip(); } });
        it('vendored test/fixtures/action-manifest.json is byte-identical to canonical', function () {
            assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
                'vendored action-manifest.json drifted from canonical; edit ' +
                'xchain-documentation/protocol/action-manifest.json and re-vendor all copies.');
        });
    });
});
