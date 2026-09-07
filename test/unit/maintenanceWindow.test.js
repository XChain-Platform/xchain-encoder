'use strict';

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
 * Scheduled-maintenance window.
 *
 * The monthly tracker-bootstrap publish takes the UTXO tracker down, so
 * /status answers 503 with tracker_reachable:false and the public board
 * paints the encoder Degraded for the length of the run. The probe is
 * right; what it lacked was the operator's declaration that the outage
 * was planned.
 *
 * Two properties matter more than the happy path here:
 *   1. The window is CONTEXT. It never touches tracker_reachable /
 *      tracker_synced and never moves the 503, so it cannot be used to
 *      paint an un-serveable encoder green.
 *   2. Every malformed, unbounded, or stale sentinel resolves to "no
 *      maintenance", which puts the row back on Degraded. A publish that
 *      crashes without cleaning up stops excusing itself at its own
 *      declared end time instead of hiding the outage forever.
 *
 ********************************************************************/

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    parseMaintenanceWindow,
    readMaintenanceWindow,
    sentinelPath,
    DEFAULT_SENTINEL,
    MAX_SENTINEL_BYTES,
    MAX_REASON_CHARS,
    MAX_WINDOW_MS
} = require('../../src/maintenanceWindow');

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const in2h = new Date(NOW + 2 * 3600 * 1000).toISOString();

describe('maintenanceWindow: an operator-declared scheduled outage @regression', function () {

    describe('parseMaintenanceWindow()', function () {

        it('reports an open, bounded window as active', function () {
            const w = parseMaintenanceWindow(JSON.stringify({
                reason: 'monthly bootstrap publish', since: new Date(NOW - 60000).toISOString(), until: in2h
            }), NOW);
            assert.ok(w, 'expected an active window');
            assert.strictEqual(w.active, true);
            assert.strictEqual(w.reason, 'monthly bootstrap publish');
            assert.strictEqual(w.until, in2h);
        });

        it('accepts epoch-millisecond timestamps as well as ISO strings', function () {
            const w = parseMaintenanceWindow(JSON.stringify({ until: NOW + 60000 }), NOW);
            assert.ok(w);
            assert.strictEqual(w.until, new Date(NOW + 60000).toISOString());
        });

        // The whole point of requiring an expiry: a publish killed mid-run leaves
        // its sentinel behind, and a window with no end would excuse a genuine
        // dead encoder for as long as nobody noticed.
        it('refuses a window with no expiry', function () {
            assert.strictEqual(parseMaintenanceWindow(JSON.stringify({ reason: 'forever' }), NOW), null);
        });

        it('refuses an expired window, so a stale sentinel self-heals to Degraded', function () {
            const w = JSON.stringify({ until: new Date(NOW - 1000).toISOString() });
            assert.strictEqual(parseMaintenanceWindow(w, NOW), null);
        });

        it('refuses a window longer than the ceiling', function () {
            const tooLong = JSON.stringify({ until: NOW + MAX_WINDOW_MS + 60000 });
            assert.strictEqual(parseMaintenanceWindow(tooLong, NOW), null);
            const atCeiling = JSON.stringify({ until: NOW + MAX_WINDOW_MS });
            assert.ok(parseMaintenanceWindow(atCeiling, NOW), 'the ceiling itself is still a window');
        });

        it('holds a pre-announced window inactive until it opens', function () {
            const later = JSON.stringify({ since: new Date(NOW + 3600 * 1000).toISOString(), until: in2h });
            assert.strictEqual(parseMaintenanceWindow(later, NOW), null);
        });

        it('resolves malformed, empty, non-object and oversized sentinels to no maintenance', function () {
            for (const bad of ['', 'not json', '[]', 'null', '"just a string"', '42']) {
                assert.strictEqual(parseMaintenanceWindow(bad, NOW), null, `expected null for ${JSON.stringify(bad)}`);
            }
            const huge = JSON.stringify({ until: in2h, reason: 'x'.repeat(MAX_SENTINEL_BYTES) });
            assert.ok(huge.length > MAX_SENTINEL_BYTES);
            assert.strictEqual(parseMaintenanceWindow(huge, NOW), null, 'an oversized file is not a sentinel');
        });

        it('refuses an unparseable date rather than reading it as epoch 0 or NaN', function () {
            assert.strictEqual(parseMaintenanceWindow(JSON.stringify({ until: 'tomorrow-ish' }), NOW), null);
            assert.strictEqual(parseMaintenanceWindow(JSON.stringify({ until: {} }), NOW), null);
        });

        // The body is public JSON and the reason is free text, so it is bounded
        // and stripped before it can leave the process.
        it('bounds and sanitizes the reason', function () {
            const w = parseMaintenanceWindow(JSON.stringify({
                until: in2h, reason: 'line\nbreakbell ' + 'y'.repeat(MAX_REASON_CHARS)
            }), NOW);
            assert.ok(w.reason.length <= MAX_REASON_CHARS);
            assert.ok(!/[\n]/.test(w.reason), 'control characters are stripped');
        });

        it('tolerates a missing reason', function () {
            const w = parseMaintenanceWindow(JSON.stringify({ until: in2h }), NOW);
            assert.strictEqual(w.reason, '');
            assert.strictEqual(w.since, null);
        });
    });

    describe('readMaintenanceWindow()', function () {
        let dir;
        beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-maint-')); });
        afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

        it('returns null when no sentinel exists (the normal case)', async function () {
            assert.strictEqual(await readMaintenanceWindow(NOW, path.join(dir, 'absent.json')), null);
        });

        it('never throws on an unreadable path', async function () {
            assert.strictEqual(await readMaintenanceWindow(NOW, dir), null, 'a directory is not a sentinel');
        });

        it('reads an active window off disk', async function () {
            const p = path.join(dir, 'window.json');
            fs.writeFileSync(p, JSON.stringify({ reason: 'bootstrap publish', until: in2h }));
            const w = await readMaintenanceWindow(NOW, p);
            assert.strictEqual(w.active, true);
            assert.strictEqual(w.reason, 'bootstrap publish');
        });
    });

    describe('sentinelPath()', function () {
        // Default lives INSIDE the encoder container so xchain-node can write it
        // with a plain `docker exec tee` against an already-running encoder: no
        // bind mount, so no container recreate before maintenance can be reported.
        it('defaults to the in-container path and honours the env override', function () {
            const orig = process.env.ENCODER_MAINTENANCE_FILE;
            try {
                delete process.env.ENCODER_MAINTENANCE_FILE;
                assert.strictEqual(sentinelPath(), DEFAULT_SENTINEL);
                assert.match(DEFAULT_SENTINEL, /^\//, 'the default is an absolute path');
                process.env.ENCODER_MAINTENANCE_FILE = '/elsewhere/window.json';
                assert.strictEqual(sentinelPath(), '/elsewhere/window.json');
            } finally {
                if (orig === undefined) delete process.env.ENCODER_MAINTENANCE_FILE;
                else process.env.ENCODER_MAINTENANCE_FILE = orig;
            }
        });
    });
});

describe('health()/GET /status carry the window without bending readiness @regression', function () {
    const { jsonRpcController, encoder } = require('../../src/api');

    let dir, sentinel, origEnv;
    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-maint-api-'));
        sentinel = path.join(dir, 'window.json');
        origEnv = process.env.ENCODER_MAINTENANCE_FILE;
        process.env.ENCODER_MAINTENANCE_FILE = sentinel;
    });
    afterEach(function () {
        if (origEnv === undefined) delete process.env.ENCODER_MAINTENANCE_FILE;
        else process.env.ENCODER_MAINTENANCE_FILE = origEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function stubSync(status) {
        const orig = encoder.utxoTrackerConnector.getSyncStatus;
        encoder.utxoTrackerConnector.getSyncStatus = async () => status;
        return () => { encoder.utxoTrackerConnector.getSyncStatus = orig; };
    }
    function declare(minutesAhead) {
        fs.writeFileSync(sentinel, JSON.stringify({
            reason: 'utxo-tracker bootstrap publish',
            since: new Date().toISOString(),
            until: new Date(Date.now() + minutesAhead * 60000).toISOString()
        }));
    }

    it('reports maintenance null when no window is declared', async function () {
        const restore = stubSync({ synced: true, lag: 0 });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.maintenance, null);
        } finally { restore(); }
    });

    // The exact shape the monthly publish produces: the tracker is down, the
    // probe says so, and the window explains WHY without contradicting it.
    it('an unreachable tracker inside a declared window still reads unready', async function () {
        const orig = encoder.utxoTrackerConnector.getSyncStatus;
        encoder.utxoTrackerConnector.getSyncStatus = async () => { throw new Error('connect ECONNREFUSED'); };
        const restore = () => { encoder.utxoTrackerConnector.getSyncStatus = orig; };
        declare(120);
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_reachable, false, 'the probe must not be silenced by a window');
            assert.strictEqual(h.tracker_synced, false);
            assert.ok(h.maintenance && h.maintenance.active === true);
            assert.strictEqual(h.maintenance.reason, 'utxo-tracker bootstrap publish');
        } finally { restore(); }
    });

    it('a window does not make a lagging tracker read synced', async function () {
        const restore = stubSync({ synced: true, lag: encoder.maxUtxoTrackerLagBlocks + 5 });
        declare(60);
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_synced, false);
            assert.ok(h.maintenance.active);
        } finally { restore(); }
    });

    it('an expired sentinel reads as no maintenance', async function () {
        const restore = stubSync({ synced: true, lag: 0 });
        declare(-5);
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.maintenance, null);
        } finally { restore(); }
    });
});
