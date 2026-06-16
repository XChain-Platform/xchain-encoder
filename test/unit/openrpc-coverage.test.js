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
 * Drift guard: docs/openrpc.json must list exactly the methods exposed by
 * the jsonRpcController in src/api.js. If a method is added/removed/renamed,
 * regenerate the spec (node docs/openrpc.build.js) — this fails until both
 * sides match.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

describe('openrpc.json method coverage', () => {

    const src  = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/openrpc.json'), 'utf8'));

    // Method names inside the jsonRpcController object literal.
    const block = src.slice(src.indexOf('jsonRpcController = {'), src.indexOf('jsonRouter('));
    const controllerMethods = [...block.matchAll(/^\s{4}async\s+([a-z][a-z0-9_]*)\s*\(/gm)].map((m) => m[1]);

    it('extracts a sane controller method list', () => {
        assert.ok(controllerMethods.includes('ping') && controllerMethods.includes('create_tx'),
            `extraction broken: ${controllerMethods.join(', ')}`);
    });

    it('spec methods === controller methods', () => {
        const specMethods = spec.methods.map((m) => m.name).sort();
        assert.deepStrictEqual(specMethods, [...controllerMethods].sort());
    });

    it('every method has summary, paramStructure by-name, and a result', () => {
        for (const m of spec.methods) {
            assert.ok(m.summary && m.summary.length, `${m.name} summary`);
            assert.strictEqual(m.paramStructure, 'by-name', `${m.name} paramStructure`);
            assert.ok(m.result && m.result.schema, `${m.name} result`);
        }
    });
});
