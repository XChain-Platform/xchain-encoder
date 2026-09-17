'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// the shared /metrics exporter and structured log shim. The suite
// pins the three properties services depend on: valid Prometheus exposition
// text, default-off wiring (no route, no timer, no socket without env), and a
// log shim that redacts credentials and never throws at a dead collector.
//
// Ported from the canonical suite at xchain-hub/test/unit/observability/observability.test.js.
// src/observability/ here is a verbatim vendored copy, vendored and verified by
// xchain-hub/bin/sync-observability.sh. Parity is gated in the HUB, not here:
// the hub's pre-push gate (bin/ci-full.sh) and the drift-guards job of its
// ci.yml both run that script with --check against all six consumers, so a
// hand-edit to this copy reddens the hub. This file runs the same assertions
// against xchain-encoder's own copy, express version and Node engine.
// Behaviour changes belong in the canonical suite first; re-port rather than
// hand-editing, or the two drift apart silently.

const { expect } = require('chai');
const express = require('express');
const http = require('http');

const {
    Registry, Counter, Gauge, Histogram, collectDefaultMetrics
} = require('../../src/observability/metrics.js');
const {
    createLogShipper, readLogEnv, redactFields, scrubMessage, REDACTED
} = require('../../src/observability/logShipper.js');
const {
    installObservability, readObservabilityEnv, routeLabel
} = require('../../src/observability/index.js');

const registerMetricsTests = require('./observability.test/01_metrics.test.js');
const { registerLogShipperTests, registerTextLogTests } = require('./observability.test/02_log_shipper.test.js');
const registerRouteTests = require('./observability.test/03_routes.test.js');
const { registerFlushAndHealthTests, registerConsolePatchTests } = require('./observability.test/04_flush_and_health.test.js');

// A console-shaped sink so tests never write to the mocha output.
function fakeConsole() {
    const lines = { log: [], warn: [], error: [] };
    return {
        lines,
        log:   (m) => lines.log.push(m),
        warn:  (m) => lines.warn.push(m),
        error: (m) => lines.error.push(m)
    };
}

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        port,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

describe('observability/metrics: exposition format', function () {
    registerMetricsTests({ expect, Registry, Counter, Gauge, Histogram, collectDefaultMetrics });
});

describe('observability/logShipper', function () {
    const context = { expect, http, fakeConsole, createLogShipper, readLogEnv, redactFields, scrubMessage, REDACTED, Registry };
    registerLogShipperTests(context);
    registerFlushAndHealthTests(context);
});

describe('observability/installObservability', function () {

    // The registry and shipper are process-wide by design (one process is one
    // service), so a suite that installs many times has to drop them between
    // cases or it reads the previous case's service label and HTTP series.
    afterEach(function () { require('../../src/observability/index.js')._resetObservability(); });

    registerRouteTests({ expect, express, fakeConsole, listen, installObservability, readObservabilityEnv, routeLabel });
});

// The fleet runs text mode, so text mode is where the structured record has to
// survive. Before this, _emitLocal's text branch printed the message alone and
// threw the whole record away: LOG_LEVEL and LOG_FORMAT changed nothing an
// operator could see on any box.
describe('observability/logShipper: text-with-fields format', function () {
    registerTextLogTests({ expect, fakeConsole, createLogShipper, REDACTED });
});

describe('observability/logShipper: message redaction', function () {
    // An env-validation failure prints the variable NAME and its value, and the
    // names the services use are all prefixed (HUB_DB_SECRET, INDEXER_DB_PASS,
    // db_password). A `\b`-anchored key never matches those, because `_` is a
    // word character and `\b` does not fire between two word characters. With
    // LOG_SHIP_* configured, an unscrubbed line goes off-box in the clear.
    const leaky = [
        ['prefixed env secret',   'Missing required environment variable: HUB_DB_SECRET=hunter2swordfish'],
        ['prefixed db pass',      'connect failed db_password=hunter2swordfish'],
        ['screaming env pass',    'INDEXER_DB_PASS=hunter2swordfish'],
        ['api key',               'HUB_API_KEY=hunter2swordfish'],
        ['keyed bearer',          'Authorization: Bearer eyJhbGciOi.SECRETPAYLOAD.sig'],
        ['bare bearer',           'sending Bearer eyJhbGciOi.SECRETPAYLOAD.sig upstream'],
        ['quoted mnemonic',       'mnemonic="correct horse battery staple"'],
    ];
    for (const [name, line] of leaky) {
        it(`scrubs a ${name}`, function () {
            const out = scrubMessage(line);
            expect(out).to.not.match(/hunter2swordfish|SECRETPAYLOAD|correct horse/);
            expect(out).to.include(REDACTED);
        });
    }

    it('redacts the token, not the word Bearer', function () {
        // The value group would otherwise capture "Bearer" and stop, leaving the
        // token itself in the clear immediately after a [redacted] marker that
        // makes the line look handled.
        const out = scrubMessage('Authorization: Bearer eyJhbGciOi.SECRETPAYLOAD.sig');
        expect(out).to.not.include('SECRETPAYLOAD');
    });

    it('leaves real operational lines untouched, hex identifiers included', function () {
        // Hub and indexer lines are full of legitimate 64-char hex (txids, block
        // hashes, state roots). A hex sweep here would gut the logs this work
        // exists to make readable.
        const keep = [
            'Oracle: Round 12 finalized with 4 of 5 votes',
            'StateAnchorPublisher: anchored bundle regtest @ 100 (txid a3f9bc21de)',
            'P2P: Invalid signature from xc1qexampleaddr; dropping message',
            'seed block=5 imported',
            'PBFT_DROP reason=digest_mismatch phase=prepare round=42'
        ];
        for (const line of keep) expect(scrubMessage(line)).to.equal(line);
    });
});

describe('observability/patchConsole', function () {
    const { patchConsole, unpatchConsole, getLogger, getRegistry, _resetObservability } =
        require('../../src/observability/index.js');

    afterEach(function () { _resetObservability(); });

    registerConsolePatchTests({
        expect, fakeConsole, createLogShipper, installObservability,
        patchConsole, unpatchConsole, getLogger, getRegistry
    });
});
