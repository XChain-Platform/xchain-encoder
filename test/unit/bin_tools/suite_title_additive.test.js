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
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(REPO_ROOT, 'bin', 'suite-title-map.js');
const PIN = path.join(REPO_ROOT, 'bin', 'pins', 'at1-suite-titles.json');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp');

function loadPin() {
    return JSON.parse(fs.readFileSync(PIN, 'utf8'));
}

function titlesFor(pin, file) {
    return pin.titleSets[pin.scripts.test.files[file]];
}

function setTitles(pin, file, titles, suffix) {
    const key = `suite-title-additive-${suffix}`;
    pin.titleSets[key] = titles;
    pin.scripts.test.files[file] = key;
}

function pinnedFilesWithTitles(pin) {
    return Object.keys(pin.scripts.test.files)
        .filter((file) => file.startsWith('test/unit/') && titlesFor(pin, file).length);
}

function pinnedFileWithTitles(pin) {
    return pinnedFilesWithTitles(pin)[0];
}

function compareThroughCli(pin) {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'suite-title-additive-'));
    const pinPath = path.join(dir, 'pin.json');
    try {
        fs.writeFileSync(pinPath, `${JSON.stringify(pin)}\n`);
        const result = spawnSync(process.execPath, [CLI, '--script', 'test', '--compare', pinPath], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 15000,
        });
        assert.ifError(result.error);
        return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('suite title comparison additive growth', () => {
    it('prints added files and titles without failing the compare CLI', () => {
        const pin = loadPin();
        const [file, addedFile] = pinnedFilesWithTitles(pin);
        assert.ok(file && addedFile);
        const [addedTitle, ...remainingTitles] = titlesFor(pin, file);
        setTitles(pin, file, remainingTitles, 'additive');
        // A file the tree has and the pin lacks, taken out of the pin itself so the
        // case holds whichever suites the pin was last generated from.
        delete pin.scripts.test.files[addedFile];

        const result = compareThroughCli(pin);

        assert.strictEqual(result.status, 0, result.output);
        assert.ok(result.output.includes(`[test] file_added ${addedFile}`), result.output);
        assert.ok(result.output.includes(`[test] title_added ${file} :: ${addedTitle}`), result.output);
    });

    it('prints dropped files and titles and fails the compare CLI', () => {
        const pin = loadPin();
        const file = pinnedFileWithTitles(pin);
        assert.ok(file);
        const droppedFile = 'test/unit/removed-from-tree.test.js';
        const droppedFileTitle = 'suite removed from tree';
        const droppedTitle = 'title removed from tree';
        setTitles(pin, droppedFile, [droppedFileTitle], 'dropped-file');
        setTitles(pin, file, [...titlesFor(pin, file), droppedTitle], 'dropped-title');

        const result = compareThroughCli(pin);

        assert.strictEqual(result.status, 1, result.output);
        assert.ok(result.output.includes(`[test] file_dropped ${droppedFile}`), result.output);
        assert.ok(result.output.includes(`[test] title_dropped ${file} :: ${droppedTitle}`), result.output);
    });
});
