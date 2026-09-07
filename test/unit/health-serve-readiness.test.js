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
 * health / GET /status serve-readiness gate.
 *
 * tracker_synced must mean "create_tx will serve", not the tracker's raw
 * 3-block SYNCED_THRESHOLD verdict: create_tx refuses at the tighter
 * maxUtxoTrackerLagBlocks (default 2), so a 3-block lag used to read
 * Online on the status board while create_tx returned UTXO_TRACKER_STALE.
 * These tests pin that the health gate and create_tx's overLag gate agree.
 *
 ********************************************************************/

const assert = require('assert');
const { jsonRpcController, encoder } = require('../../src/api');

function stubSync(status) {
    const orig = encoder.utxoTrackerConnector.getSyncStatus;
    encoder.utxoTrackerConnector.getSyncStatus = async () => status;
    return () => { encoder.utxoTrackerConnector.getSyncStatus = orig; };
}

describe('health(): tracker_synced is serve-readiness (create_tx parity) @regression', function () {

    it('lag over maxUtxoTrackerLagBlocks reads NOT synced even when the tracker says synced', async function () {
        const restore = stubSync({ synced: true, lag: encoder.maxUtxoTrackerLagBlocks + 1 });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_reachable, true);
            assert.strictEqual(h.tracker_synced, false,
                'a lag create_tx refuses must not read Online on the board');
            assert.strictEqual(h.tracker_lag, encoder.maxUtxoTrackerLagBlocks + 1);
        } finally { restore(); }
    });

    it('lag at the ceiling stays synced (create_tx serves at lag == max)', async function () {
        const restore = stubSync({ synced: true, lag: encoder.maxUtxoTrackerLagBlocks });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_synced, true);
        } finally { restore(); }
    });

    it('null/absent lag fails open, matching create_tx overLag gate', async function () {
        const restore = stubSync({ synced: true });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_synced, true);
            assert.strictEqual(h.tracker_lag, null);
        } finally { restore(); }
    });

    it('tracker verdict synced:false stays not synced regardless of lag', async function () {
        const restore = stubSync({ synced: false, lag: 0 });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_synced, false);
        } finally { restore(); }
    });

    // The tracker publishes halted independently of synced, so a tracker
    // frozen on an unrecoverable reorg whose last committed height still shows an
    // acceptable lag painted Online on the board.
    it('a halted tracker reads NOT synced even at lag 0', async function () {
        const restore = stubSync({ synced: true, lag: 0, halted: true, halt_reason: 'rolled back past the recovery window' });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_halted, true);
            assert.strictEqual(h.tracker_synced, false,
                'a tracker that stopped polling must never read Online on the board');
        } finally { restore(); }
    });

    it('reports tracker_halted false for a running tracker', async function () {
        const restore = stubSync({ synced: true, lag: 0 });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_halted, false);
            assert.strictEqual(h.tracker_synced, true);
        } finally { restore(); }
    });

    // Only the upper lag bound was checked here, so a tracker committed
    // ABOVE the node's tip (node reset or reindex) read Online while its outputs sat
    // in blocks the node no longer recognizes.
    it('a tracker ahead of the node reads NOT synced', async function () {
        const restore = stubSync({ synced: true, lag: -100 });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_synced, false);
            assert.strictEqual(h.tracker_lag, -100);
        } finally { restore(); }
    });

    // create_tx refuses UTXO_TRACKER_NOT_READY for the whole post-restart
    // window in which the mempool index is still rebuilding, so a probe blind to that
    // state paints Online on an encoder that will serve nothing: the same divergence
    // already fixed for lag.
    it('a tracker whose mempool has not reconverged reads NOT synced at lag 0', async function () {
        const restore = stubSync({ synced: true, lag: 0, mempool_ready: false });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_mempool_ready, false);
            assert.strictEqual(h.tracker_synced, false,
                'create_tx refuses here, so the board must not read Online');
        } finally { restore(); }
    });

    it('a reconverged tracker reads synced and mempool-ready', async function () {
        const restore = stubSync({ synced: true, lag: 0, mempool_ready: true });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_mempool_ready, true);
            assert.strictEqual(h.tracker_synced, true);
        } finally { restore(); }
    });

    // Fail-open parity with create_tx: a tracker predating the field omits it and must
    // not read as unready, or every un-upgraded tracker in the fleet goes dark.
    it('a tracker that omits mempool_ready fails open', async function () {
        const restore = stubSync({ synced: true, lag: 0 });
        try {
            const h = await jsonRpcController.health();
            assert.strictEqual(h.tracker_mempool_ready, true);
            assert.strictEqual(h.tracker_synced, true);
        } finally { restore(); }
    });
});

/* The ceiling above is the one thing a reader of /status could not see, and the
 * public status board guessed at it: it mirrored the tracker's own
 * SYNCED_THRESHOLD (3) instead of maxUtxoTrackerLagBlocks (2), so a lag of
 * exactly 3 fell past its lag branch and the row blamed mempool reconvergence
 * for an encoder that stays 503 until the lag drops to 2. Publishing the number
 * ends the mirroring, and matters twice because UTXO_TRACKER_MAX_LAG_BLOCKS
 * moves it per deployment, so no constant could have been right everywhere.
 *
 * /status only. The JSON-RPC health() shape is documented in docs/openrpc.json
 * and stays as it is. */
describe('GET /status publishes the lag ceiling its readiness was gated on @regression', function () {
    const http = require('http');
    const { app, encoder } = require('../../src/api');

    async function statusBody() {
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/status`);
            return await res.json();
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }

    it('reports tracker_max_lag_blocks equal to the gate create_tx enforces', async function () {
        const restore = stubSync({ synced: true, lag: 0 });
        try {
            const body = await statusBody();
            assert.strictEqual(body.tracker_max_lag_blocks, encoder.maxUtxoTrackerLagBlocks);
            assert.strictEqual(typeof body.tracker_max_lag_blocks, 'number',
                'a board range-checks this field, so it must arrive as a number');
        } finally { restore(); }
    });

    // The whole point of publishing it: an operator who widens the ceiling gets
    // the widened number, not the default a board would otherwise hardcode.
    it('follows a non-default ceiling rather than reporting the default', async function () {
        const orig = encoder.maxUtxoTrackerLagBlocks;
        const restore = stubSync({ synced: true, lag: 0 });
        try {
            encoder.maxUtxoTrackerLagBlocks = orig + 4;
            const body = await statusBody();
            assert.strictEqual(body.tracker_max_lag_blocks, orig + 4);
            assert.notStrictEqual(body.tracker_max_lag_blocks, orig);
        } finally {
            encoder.maxUtxoTrackerLagBlocks = orig;
            restore();
        }
    });

    it('leaves the documented JSON-RPC health() shape alone', async function () {
        const restore = stubSync({ synced: true, lag: 0 });
        try {
            const h = await jsonRpcController.health();
            assert.ok(!('tracker_max_lag_blocks' in h),
                'health() is pinned by docs/openrpc.json; the ceiling rides on /status only');
        } finally { restore(); }
    });
});
