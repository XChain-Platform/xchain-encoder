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

// A cross-repo guard that checks its sibling with a bare existsSync (or reads
// it with no check at all) never asks whether the path is a lane symlink into
// a live main checkout, so it can pass against bytes no commit holds. The
// helper in test/helpers/sibling_checkout.js closes that, but only for guards
// that call it. This census walks every test source and fails on a file whose
// code names a sibling repo yet never calls siblingCheckout(), so a new bare
// guard cannot land unnoticed.
//
// A mention in a comment is not a read and is ignored. The allowlist holds the
// files that name siblings without reading their content.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT = path.join(__dirname, '../../..');
const TEST_ROOT = path.join(REPO_ROOT, 'test');

const ALLOWED = new Map([
    ['test/helpers/sibling_checkout.js', 'defines the helper'],
    ['test/unit/repo/sibling_coverage.test.js', 'reports which siblings are present and reads none'],
    ['test/unit/repo/sibling_read_census.test.js', 'this census names siblings only as detection patterns'],
]);

const SIBLING_NAME = /xchain-(?!encoder\b)[a-z][a-z0-9-]*/;
const SIBLING_ENV  = /\bXCHAIN_(?!REQUIRE_SIBLINGS|SIBLING)[A-Z_]+_DIR\b/;

// Drops block comments and line comments so a mention in prose is not a read.
// A `//` only opens a comment at line start or after whitespace, which keeps
// the scheme separator of a URL inside a string literal.
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');
}

// True when the code reaches a sibling repo without going through the helper.
function readsSiblingWithoutHelper(source) {
    const code = stripComments(source);
    if (code.includes('siblingCheckout(')) return false;
    return SIBLING_NAME.test(code) || SIBLING_ENV.test(code);
}

function testSources(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...testSources(full));
        else if (entry.name.endsWith('.js')) found.push(full);
    }
    return found;
}

describe('sibling read census', function () {
    it('classifies a bare existsSync sibling guard as a read without the helper', function () {
        const bare = "const P = path.join(__dirname, '../../../xchain-decoder/src/x.js');\n"
            + 'if (!fs.existsSync(P)) this.skip();\n';
        assert.strictEqual(readsSiblingWithoutHelper(bare), true);
        assert.strictEqual(readsSiblingWithoutHelper("const D = process.env.XCHAIN_SDK_DIR || '.';"), true);
    });

    it('passes a guard that routes its sibling through siblingCheckout', function () {
        const guarded = "const P = path.join(__dirname, '../../../xchain-decoder/src/x.js');\n"
            + "skipOrFail(this, siblingCheckout(__dirname, P), 'the guard');\n";
        assert.strictEqual(readsSiblingWithoutHelper(guarded), false);
    });

    it('ignores a sibling named only in a comment and the encoder itself', function () {
        const prose = '// mirrors xchain-decoder/test/unit/x.test.js\n'
            + '/* see xchain-documentation/protocol */\n'
            + "const own = require('../../xchain-encoder/src/x.js');\n";
        assert.strictEqual(readsSiblingWithoutHelper(prose), false);
    });

    it('keeps a URL scheme inside a string from hiding a sibling read', function () {
        const source = "const u = 'http://host'; const P = '../xchain-hub/src/coins';\n";
        assert.strictEqual(readsSiblingWithoutHelper(source), true);
    });

    it('finds no test source that reads a sibling without the helper', function () {
        const files = testSources(TEST_ROOT);
        assert.ok(files.length > 100, 'the walk found too few test sources: ' + files.length);
        const offenders = files
            .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
            .filter((rel) => !ALLOWED.has(rel))
            .filter((rel) => readsSiblingWithoutHelper(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')));
        assert.deepStrictEqual(offenders, [],
            'these files name a sibling repo in code but never call siblingCheckout(): ' + offenders.join(', '));
    });

    it('keeps every allowlisted file present', function () {
        for (const rel of ALLOWED.keys()) {
            assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), 'allowlisted file is gone: ' + rel);
        }
    });
});
