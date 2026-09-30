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
const Module = require('module');
const path = require('path');

const helpersPath = require.resolve('../../../src/XChainEncoder/script_amount_helpers.js');
const helpersModule = new Module(helpersPath, module);
helpersModule.filename = helpersPath;
helpersModule.paths = Module._nodeModulePaths(path.dirname(helpersPath));
helpersModule._compile(
    `${fs.readFileSync(helpersPath, 'utf8')}\nmodule.exports.compactSizeBuffer = compactSizeBuffer;\n`,
    helpersPath
);

const {
    asSatValue,
    compactSizeBuffer,
    compactSizeLen,
    softDustFloorFor,
} = helpersModule.exports;

describe('script amount helpers', function () {
    it('reports compactSize widths at the one-byte, uint16, and uint32 boundaries', function () {
        assert.strictEqual(compactSizeLen(252), 1);
        assert.strictEqual(compactSizeLen(253), 3);
        assert.strictEqual(compactSizeLen(0xffff), 3);
        assert.strictEqual(compactSizeLen(0x10000), 5);
    });

    it('serializes compactSize values in little-endian wire form', function () {
        assert.deepStrictEqual(compactSizeBuffer(253), Buffer.from([0xfd, 0xfd, 0x00]));
        assert.deepStrictEqual(compactSizeBuffer(0x10000), Buffer.from([0xfe, 0x00, 0x00, 0x01, 0x00]));
    });

    it('narrows safe BigInt satoshi values while preserving larger values', function () {
        const safe = BigInt(Number.MAX_SAFE_INTEGER);
        const unsafe = safe + 1n;
        assert.strictEqual(asSatValue(safe), Number.MAX_SAFE_INTEGER);
        assert.strictEqual(asSatValue(unsafe), unsafe);
        assert.strictEqual(typeof asSatValue(unsafe), 'bigint');
    });

    it('applies the Dogecoin soft dust floor only to recognized Dogecoin networks', function () {
        assert.strictEqual(softDustFloorFor('dogecoin-mainnet'), 1000000);
        assert.strictEqual(softDustFloorFor('bitcoin-mainnet'), 0);
        assert.strictEqual(softDustFloorFor('nodash'), 0);
    });
});
