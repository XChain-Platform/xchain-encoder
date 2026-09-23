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
 *
 * XChain Encoder - API
 *
 * This file parses in environmental variables and starts up the encoder instance
 *
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

// Before anything else logs. The API_KEY notice and env-validation lines
// immediately below are exactly the ones an operator needs levelled and
// timestamped, and installObservability does not run until ~190 lines further
// down.
const { patchConsole } = require('./observability');
patchConsole({
    service: 'xchain-encoder',
    version: require('../package.json').version,
    network: process.env.NETWORK || ''
});

const bitcoin = require('bitcoinjs-lib');
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { limitedHandler } = require('./server/rate_limit_log.js')
const XChainEncoder  = require('./XChainEncoder');
const jsonRouter = require('express-json-rpc-router')
const concurrencyGate = require('./server/concurrency_gate.js')

// Express middleware that rejects an over-cap JSON-RPC batch array before dispatch, so one
// HTTP request cannot amplify into thousands of backend RPCs (the rate limiter counts a batch
// as one request). Exported for unit testing.
function makeRpcBatchGuard(maxBatch){
    return (req, res, next) => {
        if (Array.isArray(req.body) && req.body.length > maxBatch){
            return res.status(400).json({
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Batch too large (max ' + maxBatch + ' requests per call)' }
            })
        }
        next()
    }
}
const { assertSingleInstance, acquireInstanceLock, releaseLockOnSignals } = require('./server/single_instance_guard')
const { parseCorsOrigin } = require('./server/cors_origin')
const { version: ENCODER_VERSION } = require('../package.json')
const { installObservability } = require('./observability');   // default-off /metrics + structured log shim
const { installCrashHandlers } = require('./server/crash_handlers')


const NETWORK = process.env.NETWORK
const NODE_URL = process.env.NODE_URL
const NODE_PORT = process.env.NODE_PORT
const NODE_USER = process.env.NODE_USER
const NODE_PASSWORD = process.env.NODE_PASSWORD
const UTXO_TRACKER_URL = process.env.UTXO_TRACKER_URL
const UTXO_TRACKER_API_PORT = process.env.UTXO_TRACKER_API_PORT
const ENCODER_API_PORT = process.env.ENCODER_API_PORT
const MAX_FEE_RATE_KB = process.env.MAX_FEE_RATE_KB ? parseInt(process.env.MAX_FEE_RATE_KB, 10) : null
// Relative fee-rate ceiling as a multiple of the node's estimatesmartfee(1)
// estimate (default 10). Caps caller-supplied fee/feePerKb so a hostile request
// cannot drain inputs into miner fee. Set to 0 to disable (not recommended).
// An unset or unparseable value keeps the encoder default (fail-safe).
const _maxFeeRateMultiplier = parseFloat(process.env.MAX_FEE_RATE_MULTIPLIER)
const MAX_FEE_RATE_MULTIPLIER = Number.isFinite(_maxFeeRateMultiplier) ? _maxFeeRateMultiplier : undefined
// Max blocks the utxo-tracker's per-response freshness `sync` field may report
// as lag before create_tx refuses to select UTXOs from it
// (UTXO_TRACKER_STALE). Unset/unparseable falls through to XChainEncoder's own default
// (DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS) via the `undefined` fallback, same
// pattern as MAX_FEE_RATE_MULTIPLIER above.
const _utxoTrackerMaxLagBlocks = parseInt(process.env.UTXO_TRACKER_MAX_LAG_BLOCKS, 10)
const UTXO_TRACKER_MAX_LAG_BLOCKS = Number.isFinite(_utxoTrackerMaxLagBlocks) ? _utxoTrackerMaxLagBlocks : undefined
// Operator floor on every value output the encoder authors; it only raises the floor
// above the coin dust threshold and relay-policy soft-dust floor (see XChainEncoder).
const _dustAmount = parseInt(process.env.DUST_AMOUNT, 10)
const DUST_AMOUNT = (Number.isFinite(_dustAmount) && _dustAmount > 0) ? _dustAmount : undefined
const API_KEY = process.env.API_KEY
const CORS_ORIGIN = process.env.CORS_ORIGIN

// Constant-time API-key comparison. A plain `!==` short-circuits at the first
// mismatching byte, leaking the key through response-time differences;
// timingSafeEqual needs equal-length buffers, so length is guarded first.
function keyEquals(provided, expected){
    const a = Buffer.from(String(provided == null ? '' : provided))
    const b = Buffer.from(String(expected == null ? '' : expected))
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
}

// API key authentication is OPTIONAL (see README.md; default: disabled).
// When API_KEY is unset the encoder runs open; setting it opts into x-api-key enforcement.
if (!API_KEY) {
    console.warn('NOTICE: API_KEY not set. Encoder API authentication is DISABLED (open access).')
}

const encoder = new XChainEncoder(NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, UTXO_TRACKER_URL, UTXO_TRACKER_API_PORT, MAX_FEE_RATE_KB, MAX_FEE_RATE_MULTIPLIER, UTXO_TRACKER_MAX_LAG_BLOCKS, DUST_AMOUNT);

const app = express();

// Trust proxy configuration for the per-IP rate limiter below. Without this,
// req.ip is always the socket peer address; the status board is same-origin
// with the encoder behind a fronting proxy (see docs/README deployment
// notes), so every visitor's requests arrive from the proxy's IP and all
// clients share ONE rate-limit bucket, tripping 429s under modest concurrent
// load. `true` must NOT be the default:
// it would trust ANY client-supplied X-Forwarded-For, letting callers spoof
// their IP past the per-IP limiter (express-rate-limit's
// ERR_ERL_PERMISSIVE_TRUST_PROXY warning). The default trusts loopback plus
// private-range peers: a native deploy sees the host proxy as loopback, a
// containerized deploy sees it as the docker bridge IP (uniquelocal); both
// recover the real client IP. Exposed directly to the internet, a forged XFF
// is ignored (public socket address) and req.ip is the socket address.
// ENCODER_TRUST_PROXY overrides for other topologies: `false`, a hop count
// (e.g. `1`), or an address/CIDR list per the Express docs. Mirrors
// xchain-hub's HUB_TRUST_PROXY (src/api.js).
let trustProxy = process.env.ENCODER_TRUST_PROXY || 'loopback, uniquelocal';
if (trustProxy === 'true')       trustProxy = true;
else if (trustProxy === 'false') trustProxy = false;
else if (/^\d+$/.test(trustProxy)) trustProxy = parseInt(trustProxy, 10);
app.set('trust proxy', trustProxy);

app.use(helmet());

// CORS configuration (default: disabled; `*` allows all; a comma-separated list
// is an ALLOWLIST matched per-origin). parseCorsOrigin is what makes the list
// case work: handing `cors` the raw string would echo it verbatim to everyone
// and be accepted by no browser. See src/server/cors_origin.js.
//
// Mounted above the API-key gate and the shedding layers, and the position is
// load-bearing: a preflight is an OPTIONS carrying no x-api-key (that header is
// not CORS-safelisted, which is what forces the preflight), so a gate mounted
// first answers it 401 bare and the browser never sends the real request. The
// same order is what lets a browser read the gate 401 and the limiter/gate 429s
// rather than an opaque network error. Trade: a preflight skips the limiter and
// both gates for a 204 that does no upstream work, as in every sibling service.
// Ordering pinned by test/unit/api/cors_preflight.test.js.
app.use(cors({ origin: parseCorsOrigin(CORS_ORIGIN) }));

// 3mb (was 1mb): the TAPROOT envelope raises the largest legitimate request
// well past 1mb. A create_tx may carry ~400 KB of rawData
// that arrives base64/hex-encoded (~0.5-0.8 MB) or, worst case, as
// JSON-escaped Latin-1 (up to 6 bytes per payload byte); a broadcast_tx of a
// signed reveal is ~810,000 hex chars on its own. The per-method validators
// (ENVELOPE_MAX_PAYLOAD, MAX_BROADCAST_TX_HEX_LENGTH) remain the precise
// gates; this outer bound just has to stop shedding legal requests.
app.use(bodyParser.json({ limit: '3mb' }));

// API key authentication (only enforced when API_KEY is configured).
if (API_KEY) {
    app.use((req, res, next) => {
        // The machine-readable spec stays public even on keyed deploys.
        if (req.method === 'GET' && req.path === '/openrpc.json') return next()
        const key = req.headers['x-api-key']
        if (!keyEquals(key, API_KEY)) {
            return res.status(401).json({
                jsonrpc: '2.0', id: null,
                error: { code: -32001, message: 'Unauthorized' }
            })
        }
        next()
    })
}

const ENCODER_RATE_LIMIT_WINDOW_MS = 60 * 1000
const ENCODER_RATE_LIMIT_RPM = parseInt(process.env.ENCODER_RATE_LIMIT_RPM, 10) || 60
const limiter = rateLimit({
    windowMs: ENCODER_RATE_LIMIT_WINDOW_MS,
    limit: ENCODER_RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
    // Counts refusals instead of logging one line per request; see
    // src/server/rate_limit_log.js.
    handler: limitedHandler({
        service: 'Encoder',
        name: 'app-wide',
        envVar: 'ENCODER_RATE_LIMIT_RPM',
        limit: ENCODER_RATE_LIMIT_RPM,
        windowMs: ENCODER_RATE_LIMIT_WINDOW_MS,
        message: { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Too many requests' } }
    })
})
app.use(limiter)

// Global in-flight concurrency cap. The limiter above keys on the
// client IP, so a stampede spread across thousands of distinct IPs never trips
// it while every create_tx still fans out into coin-node and utxo-tracker RPCs
// on a shared, un-pooled upstream. This caps how many requests are being served
// at any instant across ALL callers and sheds the excess with an immediate 429
// rather than queueing it behind an already-saturated node. It complements the
// batch guard below: that bounds fan-out WITHIN one request, this bounds how
// many requests fan out at once. Override with ENCODER_MAX_CONCURRENT_REQUESTS;
// 0 disables the cap.
//
// GET /status and GET /openrpc.json stay answerable while the main gate sheds:
// the first is the readiness probe the status board and monitors poll (an
// encoder that 429s its own healthcheck gets restarted instead of being allowed
// to shed), the second is a cached file read. They get a small private reserve
// rather than a blanket exemption, because /status makes an HTTP round-trip to
// the utxo-tracker on every call and an uncapped exempt route is just where the
// stampede would move next.
const BUSY_BODY = { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Server busy, retry shortly' } }
const isProbe = (req) => req.method === 'GET' && (req.path === '/status' || req.path === '/openrpc.json')

const probeGate = concurrencyGate.createConcurrencyGate({
    limit:      concurrencyGate.resolveLimit(process.env.ENCODER_MAX_CONCURRENT_PROBES, 16),
    retryAfter: 1,
    skip:       (req) => !isProbe(req),
    body:       BUSY_BODY
})
app.use(probeGate)

const requestGate = concurrencyGate.createConcurrencyGate({
    limit:      concurrencyGate.resolveLimit(process.env.ENCODER_MAX_CONCURRENT_REQUESTS, 50),
    retryAfter: 1,
    skip:       isProbe,
    body:       BUSY_BODY
})
app.use(requestGate)

// Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
// Nothing is registered and no timer starts unless METRICS_ENABLED (and, for log
// shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set, so the encoder gains no new
// listening surface by accident. Wired AFTER the rate limiter and concurrency
// gates on purpose: an enabled scrape endpoint is subject to the same shedding
// as every other route. The request-timing middleware hoists itself to the front
// of the stack so it still measures the routes registered above.
// See src/observability/README.md.
installObservability(app, {
    service: 'xchain-encoder',
    version: ENCODER_VERSION,
    network: NETWORK || ''
});

// The readiness probe and every JSON-RPC method live beside this file; they
// close over the encoder instance and network built above, so the part hands
// back the controller from a factory rather than a module-level literal.
const jsonRpcController = require('./api/json_rpc_methods.js').createJsonRpcController({ encoder, NETWORK })

// GET /status: returns 200 when the encoder's hard dependencies are reachable
// and the UTXO tracker is synced, or 503 when not. Distinct from the JSON-RPC
// `health` method so load-balancer / uptime monitors can rely on the HTTP status
// code directly (the JSON-RPC catch-all routes all GETs to 200 today). Shares
// the readiness gate with health() by calling that very method (its
// getServeReadiness() lives in src/api/json_rpc_methods.js) so the two
// endpoints cannot drift apart.
// probeGate.hold, not requestGate.hold: /status is exempted from the main cap by
// `skip`, so its slot lives in the probe reserve and only that gate's hold() can
// find it. This route awaits an HTTP round-trip to the utxo-tracker, so without
// the wrapper a monitor that hangs up on a slow probe frees its reserve slot
// while the round-trip is still outstanding.
app.get('/status', probeGate.hold(async (req, res) => {
    // tracker_halted and tracker_mempool_ready travel alongside so the board names WHY
    // an unhealthy encoder is unhealthy; both already fold into tracker_synced above.
    const { tracker_reachable, tracker_synced, tracker_lag, tracker_halted, tracker_mempool_ready, maintenance } = await jsonRpcController.health()
    const healthy = tracker_reachable && tracker_synced
    // A declared window does NOT move the code. The encoder still cannot serve,
    // and every load balancer and uptime monitor keyed on this 503 must keep
    // seeing it; the window is context for whoever reads the body, not a way to
    // paint an un-serveable endpoint green.
    const code = healthy ? 200 : 503
    // Publishes the lag ceiling tracker_synced was actually gated on, so a
    // status board can rank lag against mempool without mirroring a constant
    // it cannot see. Mirroring guessed wrong in both directions: the tracker's
    // own SYNCED_THRESHOLD is 3 while this gate defaults to 2, and
    // UTXO_TRACKER_MAX_LAG_BLOCKS moves it per deployment. Read-only config,
    // /status only: the JSON-RPC health() shape stays as docs/openrpc.json
    // documents it.
    const tracker_max_lag_blocks = encoder.maxUtxoTrackerLagBlocks
    // request_gate exposes the global concurrency cap and how many requests it
    // has shed; a climbing shed count is the only outward sign that a
    // distinct-IP stampede is being refused.
    res.status(code).json({ status: healthy ? 'healthy' : 'unhealthy', tracker_reachable, tracker_synced, tracker_lag, tracker_halted, tracker_mempool_ready, tracker_max_lag_blocks, maintenance, request_gate: requestGate.getStats(), probe_gate: probeGate.getStats() })
}))

// Machine-readable API spec (OpenRPC 1.3.2). Regenerated by docs/openrpc.build.js;
// test/unit/api/openrpc_coverage.test.js keeps it in lockstep with jsonRpcController.
let openrpcSpec = null
app.get('/openrpc.json', (req, res) => {
    if (!openrpcSpec)
        openrpcSpec = require('fs').readFileSync(require('path').join(__dirname, '../docs/openrpc.json'))
    res.set('Cache-Control', 'public, max-age=3600')
    res.type('application/json').send(openrpcSpec)
})

// Bound JSON-RPC batch size. express-json-rpc-router runs Promise.all over every element
// of a batch array, while the per-IP rate limiter counts the whole batch as ONE request, so
// a single ~1MB array of thousands of calls fans out into thousands of concurrent handlers -
// each estimate_fee/create_tx/get_utxos does node or tracker RPCs with no concurrency limit,
// exhausting the shared coin-node RPC pool from one unauthenticated request. Cap the batch
// length (default 20, ENCODER_MAX_RPC_BATCH). Must run after bodyParser and before the router.
app.use(makeRpcBatchGuard(parseInt(process.env.ENCODER_MAX_RPC_BATCH, 10) || 20))

// Express 5 / body-parser 2.x leaves req.body undefined when a request carries
// no JSON body (a GET, or a POST without application/json), whereas body-parser
// 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
// it throws ("req.body is required"). Restore the {} default so unmatched requests
// that fall through to this root-mounted router get a normal JSON-RPC error
// response instead of crashing the request.
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
// requestGate.hold: the router's middleware is async and awaits every method it
// dispatches, batch entries included, so ONE wrap holds the slot for the whole
// fan-out. Without it a client could start a create_tx, hang up, and get a fresh
// slot immediately while the first build was still spending node and tracker
// RPCs - the cap then admits unbounded real work with in_flight reading zero.
// A route added below this line without the wrapper sits outside the cap again.
app.use(requestGate.hold(jsonRouter({methods: jsonRpcController})))


// Start the server only when run directly (node src/api.js). When required by a
// test the controller and app are exported without binding a port.
if (require.main === module) {
  // HARD deploy constraint: the outpoint-reservation double-spend guard, the
  // recent-build duplicate refusal, the envelope-cancel owner set, the
  // reservation tickets, the rate limiter and the concurrency-gate counters are
  // in-process, so exactly ONE encoder instance may serve an endpoint. Fail at
  // boot if the deploy declares replicas > 1 (ENCODER_REPLICAS) or another
  // encoder process on this host already holds the instance lock. See
  // src/server/single_instance_guard.js.
  // Before the instance guard, so a throw inside it is still a CRASH record
  // rather than node's bare stderr dump.
  installCrashHandlers()
  assertSingleInstance()
  const releaseInstanceLock = acquireInstanceLock()
  process.on('exit', releaseInstanceLock)
  // 'exit' covers only a self-directed exit. `docker stop`/`docker restart`
  // kill this process with SIGTERM, which needs its own release or the lockfile
  // outlives every restart.
  releaseLockOnSignals(releaseInstanceLock)
  app.listen(ENCODER_API_PORT, () => {
    console.log('API listening on port '+ENCODER_API_PORT);
  });
}

module.exports = { app, jsonRpcController, encoder, makeRpcBatchGuard, requestGate, probeGate }
