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
 * The AT1 identity pin for xchain-encoder: sha256 of every file whose byte
 * identity a later milestone must not move by accident. Two populations:
 *
 *   coins        the five hub-vendored src/coins/ files, refreshed by
 *                sync-coins.sh and never edited here. A rename or a byte
 *                edit both move the hash, so this pin catches either.
 *   conformance  test/fixtures/roundtrip-conformance.json, whose canonical
 *                copy is THIS repo (decoder and sdk copy it outward). It is
 *                pinned here for the same reason: nothing here may move
 *                a byte in it, only its consumers may.
 *
 * USAGE
 *   node bin/pin-identity.js --out bin/pins/identity.json    write the pin
 *   node bin/pin-identity.js --compare bin/pins/identity.json  re-read and
 *                                                             diff against it
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');

const COINS_FILES = [
    'src/coins/BTC.js',
    'src/coins/LTC.js',
    'src/coins/DOGE.js',
    'src/coins/index.js',
    'src/coins/consensus_pin.js',
];

const CONFORMANCE_FILES = [
    'test/fixtures/roundtrip-conformance.json',
];

function sha256(rel) {
    const abs = path.join(REPO_ROOT, rel);
    const buf = fs.readFileSync(abs);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildPin() {
    const coins = {};
    for (const rel of COINS_FILES) coins[rel] = sha256(rel);
    const conformance = {};
    for (const rel of CONFORMANCE_FILES) conformance[rel] = sha256(rel);
    return { capturedAt: new Date().toISOString(), coins, conformance };
}

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--out') { opts.out = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--compare') { opts.compare = path.resolve(argv[i + 1]); i += 1; }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const pin = buildPin();
    if (opts.compare) {
        const prior = JSON.parse(fs.readFileSync(opts.compare, 'utf8'));
        const diffs = [];
        for (const rel of Object.keys(prior.coins || {})) {
            if (pin.coins[rel] !== prior.coins[rel]) diffs.push(`coins:${rel}`);
        }
        for (const rel of Object.keys(prior.conformance || {})) {
            if (pin.conformance[rel] !== prior.conformance[rel]) diffs.push(`conformance:${rel}`);
        }
        if (diffs.length) {
            console.log(`${diffs.length} identity difference(s): ${diffs.join(', ')}`);
            process.exitCode = 1;
            return;
        }
        console.log('identity pin holds: coins and conformance byte-identical');
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

module.exports = { buildPin, COINS_FILES, CONFORMANCE_FILES };
