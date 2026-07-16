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
 * health / GET /status serve-readiness gate (#2263).
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
});
