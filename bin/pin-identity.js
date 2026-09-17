#!/usr/bin/env node
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
 * The AT1 identity pin records sha256 for the five vendored coin-registry
 * files and every whole-file twin carried by this repository.
 *
 * USAGE
 *   node bin/pin-identity.js --out bin/pins/at1-identity.json
 *   node bin/pin-identity.js --compare
 *   node bin/pin-identity.js --compare <pin>
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PIN = path.join(REPO_ROOT, 'bin', 'pins', 'at1-identity.json');

const COINS_FILES = [
    'src/coins/BTC.js',
    'src/coins/LTC.js',
    'src/coins/DOGE.js',
    'src/coins/index.js',
    'src/coins/consensus_pin.js',
];

const VENDORED_TWIN_FILES = [
    '.github/workflows/verify-tag.yml',
    'src/observability/README.md',
    'src/observability/index.js',
    'src/observability/logShipper.js',
    'src/observability/metrics.js',
    'test/fixtures/action-manifest.json',
    'test/fixtures/roundtrip-conformance.json',
    'test/fixtures/utxo-record-conformance.json',
    'tools/release/release-signing-fingerprint.txt',
    'tools/release/release-signing-key.asc',
];

function sha256(rel) {
    const abs = path.join(REPO_ROOT, rel);
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function hashExisting(files) {
    const hashes = {};
    for (const rel of files) {
        if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
            throw new Error(`identity file is missing: ${rel}`);
        }
        hashes[rel] = sha256(rel);
    }
    return hashes;
}

function buildPin() {
    const coinsDirectory = path.join(REPO_ROOT, 'src', 'coins');
    const coinsPresent = fs.existsSync(coinsDirectory);
    const coins = coinsPresent ? hashExisting(COINS_FILES) : {};
    const vendoredTwins = hashExisting(VENDORED_TWIN_FILES);
    const pin = { capturedAt: new Date().toISOString(), coins, vendoredTwins };
    if (!coinsPresent) pin.coinsNote = 'repo has no src/coins/ directory';
    if (!VENDORED_TWIN_FILES.length) pin.vendoredTwinsNote = 'repo carries no vendored twin files';
    return pin;
}

function comparable(pin) {
    return {
        coins: pin.coins || {},
        coinsNote: pin.coinsNote || null,
        vendoredTwins: pin.vendoredTwins || {},
        vendoredTwinsNote: pin.vendoredTwinsNote || null,
    };
}

function differences(prior, fresh) {
    const diffs = [];
    for (const group of ['coins', 'vendoredTwins']) {
        const before = prior[group] || {};
        const after = fresh[group] || {};
        const files = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const rel of [...files].sort()) {
            if (!(rel in before)) diffs.push(`${group}:${rel}:added`);
            else if (!(rel in after)) diffs.push(`${group}:${rel}:removed`);
            else if (before[rel] !== after[rel]) diffs.push(`${group}:${rel}:hash`);
        }
    }
    for (const field of ['coinsNote', 'vendoredTwinsNote']) {
        if ((prior[field] || null) !== (fresh[field] || null)) diffs.push(`${field}:changed`);
    }
    return diffs;
}

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--out') {
            if (!argv[i + 1]) throw new Error('--out requires a path');
            opts.out = path.resolve(argv[i + 1]);
            i += 1;
        } else if (argv[i] === '--compare') {
            const next = argv[i + 1];
            opts.compare = next && !next.startsWith('--') ? path.resolve(next) : DEFAULT_PIN;
            if (next && !next.startsWith('--')) i += 1;
        } else {
            throw new Error(`unknown argument: ${argv[i]}`);
        }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const pin = buildPin();
    if (opts.compare) {
        const prior = JSON.parse(fs.readFileSync(opts.compare, 'utf8'));
        const diffs = differences(comparable(prior), comparable(pin));
        if (diffs.length) {
            console.log(`${diffs.length} identity difference(s): ${diffs.join(', ')}`);
            process.exitCode = 1;
            return;
        }
        console.log('identity pin holds: coins and vendored twins are byte-identical');
        return;
    }
    if (opts.out) {
        fs.mkdirSync(path.dirname(opts.out), { recursive: true });
        fs.writeFileSync(opts.out, `${JSON.stringify(pin, null, 2)}\n`);
        console.log(`written to ${path.relative(REPO_ROOT, opts.out)}`);
        return;
    }
    console.log(JSON.stringify(pin, null, 2));
}

if (require.main === module) main();

module.exports = { buildPin, comparable, differences, COINS_FILES, VENDORED_TWIN_FILES };
