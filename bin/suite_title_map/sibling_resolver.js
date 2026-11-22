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

const fs = require('fs');
const path = require('path');
const Module = require('module');

function findPlatformRoot(start) {
    let cursor = path.resolve(start);
    while (path.dirname(cursor) !== cursor) {
        if (fs.existsSync(path.join(cursor, 'xchain-documentation'))) return cursor;
        cursor = path.dirname(cursor);
    }
    return null;
}

const platformRoot = findPlatformRoot(__dirname);
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveSibling(request, parent, isMain, options) {
    if (platformRoot) {
        const match = request.match(/(?:^|\/)xchain-([a-z0-9-]+)\/(.+)$/);
        if (match) {
            const candidate = path.join(platformRoot, `xchain-${match[1]}`, match[2]);
            if (fs.existsSync(candidate)) return resolveFilename.call(this, candidate, parent, isMain, options);
        }
    }
    return resolveFilename.call(this, request, parent, isMain, options);
};
