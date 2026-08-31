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
 * regenerate the spec (node docs/openrpc.build.js); this fails until both
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

    // docs/openrpc.json is GENERATED. Hand-editing it works right up to the next
    // `node docs/openrpc.build.js`, which silently reverts the edit: commit ff4f9c5
    // added the create_tx `warnings` result field to the JSON alone, so a routine
    // regeneration would have deleted a shipped field's only documentation. The
    // generator is the source of truth; this asserts the artifact still equals it.
    it('docs/openrpc.json is exactly what docs/openrpc.build.js emits', () => {
        const built = require('../../docs/openrpc.build.js').spec;
        assert.ok(Array.isArray(built.methods) && built.methods.length > 0,
            'generator export broken: no methods');
        assert.deepStrictEqual(spec, JSON.parse(JSON.stringify(built)),
            'docs/openrpc.json is out of date or hand-edited; run: node docs/openrpc.build.js');
    });

    // Param-level drift guard. The method check above never looked at params, which
    // is how create_tx came to validate and act on `attachPrevTx` while the published
    // contract never named it: the field was undiscoverable from the spec and every
    // generated client dropped it. Every params.<x> validateAll reads must be declared.
    const validatorSrc = fs.readFileSync(path.join(__dirname, '../../src/validator.js'), 'utf8');
    // Slice validateAll's body only. `params.pubkey` also appears in an unrelated
    // function earlier in the file, and including it would make this pass for the
    // wrong reason. The digit class is required: p2shHash, p2shHex, compressedPubKey.
    const fnStart = validatorSrc.indexOf('function validateAll(');
    const fnEnd = validatorSrc.indexOf('\n    return {', fnStart);
    const validateAllBody = validatorSrc.slice(fnStart, fnEnd);
    const validatedParams = [...new Set(
        [...validateAllBody.matchAll(/params\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
    )].sort();

    it('extracts a sane validateAll param list', () => {
        assert.notStrictEqual(fnStart, -1, 'validateAll not found in src/validator.js');
        assert.ok(fnEnd > fnStart, 'validateAll body slice is empty; the return marker moved');
        assert.ok(validatedParams.includes('pubkey') && validatedParams.includes('attachPrevTx'),
            `extraction broken: ${validatedParams.join(', ')}`);
        assert.ok(validatedParams.length > 10, `extraction too small: ${validatedParams.length}`);
    });

    it('create_tx spec params === the params validateAll reads', () => {
        const createTx = spec.methods.find((m) => m.name === 'create_tx');
        assert.ok(createTx, 'create_tx missing from the spec');
        const declared = createTx.params.map((p) => p.name).sort();
        assert.deepStrictEqual(declared, validatedParams,
            'a params.<x> read in validateAll must be declared in docs/openrpc.build.js, '
            + 'then regenerate with: node docs/openrpc.build.js');
    });
});
