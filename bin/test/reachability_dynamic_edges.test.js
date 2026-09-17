/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * bin/reachability.js used to declare two DYNAMIC_EDGES (src/consensus_rules_digest.js
 * and src/db/index.js) copied verbatim out of xchain-indexer's twin, neither of which
 * this repo has. edgesFrom() only applies a declared edge while it is walking the exact
 * file the edge names as `from`, so a `from` this repo never tracks is never visited and
 * the edge quietly applies zero times, while the summary still reported
 * `declared dynamic edges: 2`, confidence the tool had not earned. This suite drives the
 * fix: DYNAMIC_EDGES is empty because this repo has no computed require, and a future
 * stale declaration fails loudly instead of repeating the silent pass.
 *
 * Outside test/ on purpose, matching bin/test/suite_title_split_map.test.js: run it
 * directly.
 *
 *   npx mocha --no-config --timeout 30000 bin/test/reachability_dynamic_edges.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const { analyse, DYNAMIC_EDGES, assertDynamicEdgesResolve } = require('../reachability.js');

describe('xchain-encoder bin/reachability.js: DYNAMIC_EDGES only names paths this repo has', () => {
    it('declares no dynamic edge, because this repo has no computed require', () => {
        assert.deepStrictEqual(DYNAMIC_EDGES, []);
    });

    it('reports dynamicEdgesDeclared: 0 in the summary, not a stale count', () => {
        const report = analyse({ siblings: false });
        assert.strictEqual(report.summary.dynamicEdgesDeclared, 0);
    });

    it('does not throw against this repo\'s own tracked tree', () => {
        assert.doesNotThrow(() => assertDynamicEdgesResolve(new Set(['src/api.js'])));
    });

    it('fails loudly, by name, when a declared edge names a file the tree does not have', () => {
        // Mutates the real exported DYNAMIC_EDGES array (module-cached, so this is
        // the same array analyse() reads) rather than a re-implemented copy of the
        // check, then restores it in `finally` so no other test in this process
        // sees the injected entry.
        const bogus = { from: 'src/does_not_exist.js', why: 'a stale or copy-pasted declaration' };
        DYNAMIC_EDGES.push(bogus);
        try {
            assert.throws(
                () => assertDynamicEdgesResolve(new Set(['src/api.js'])),
                /src\/does_not_exist\.js/,
            );
        } finally {
            DYNAMIC_EDGES.pop();
        }
        assert.deepStrictEqual(DYNAMIC_EDGES, [], 'DYNAMIC_EDGES must be restored empty after the injected edge');
    });
});
