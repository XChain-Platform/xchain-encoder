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
