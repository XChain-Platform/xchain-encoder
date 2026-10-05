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
 ********************************************************************/

'use strict';

const assert = require('assert');

const { compare, reportDifferences } = require('../../../bin/suite-title-map.js');

function mapOf(files) {
    const titleSets = {};
    const mappedFiles = {};
    let index = 0;
    for (const [file, titles] of Object.entries(files)) {
        const key = `set${index += 1}`;
        titleSets[key] = titles;
        mappedFiles[file] = key;
    }
    return { titleSets, scripts: { test: { files: mappedFiles } } };
}

function report(pinFiles, freshFiles) {
    const differences = compare(mapOf(pinFiles), mapOf(freshFiles), {}, undefined);
    const lines = [];
    const failed = reportDifferences(differences, 'pin.json', (line) => lines.push(line));
    return { differences, failed, output: lines.join('\n') };
}

describe('suite title comparison additive growth', () => {
    it('prints added files and titles without failing', () => {
        const result = report(
            { 'test/unit/pinned.test.js': ['pinned title'] },
            {
                'test/unit/pinned.test.js': ['pinned title', 'new title'],
                'test/unit/new.test.js': ['new file title'],
            },
        );

        assert.deepStrictEqual(result.differences.map((difference) => difference.kind), [
            'file_added',
            'title_added',
        ]);
        assert.strictEqual(result.failed, false);
        assert.match(result.output, /file_added test\/unit\/new\.test\.js/);
        assert.match(result.output, /title_added test\/unit\/pinned\.test\.js :: new title/);
    });

    it('fails when a pinned file or title is dropped', () => {
        const result = report(
            {
                'test/unit/dropped.test.js': ['dropped file title'],
                'test/unit/pinned.test.js': ['kept title', 'dropped title'],
            },
            { 'test/unit/pinned.test.js': ['kept title'] },
        );

        assert.deepStrictEqual(result.differences.map((difference) => difference.kind), [
            'file_dropped',
            'title_dropped',
        ]);
        assert.strictEqual(result.failed, true);
        assert.match(result.output, /file_dropped test\/unit\/dropped\.test\.js/);
        assert.match(result.output, /title_dropped test\/unit\/pinned\.test\.js :: dropped title/);
    });
});
