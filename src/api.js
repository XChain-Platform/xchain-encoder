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
const XChainEncoder  = require('./XChainEncoder');
const jsonRouter = require('express-json-rpc-router')
const concurrencyGate = require('./concurrencyGate.js')

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
const validator = require('./validator')
const { assertSingleInstance, acquireInstanceLock, releaseLockOnSignals } = require('./singleInstanceGuard')
const { upstreamErrorMessage } = require('./errorSanitize')
const { parseCorsOrigin } = require('./corsOrigin')
const { version: ENCODER_VERSION } = require('../package.json')
const { installObservability } = require('./observability');   // default-off /metrics + structured log shim
const { installCrashHandlers } = require('./crashHandlers')
const { readMaintenanceWindow } = require('./maintenanceWindow')   // operator-declared scheduled outage, reported beside readiness


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

const encoder = new XChainEncoder(NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, UTXO_TRACKER_URL, UTXO_TRACKER_API_PORT, MAX_FEE_RATE_KB, MAX_FEE_RATE_MULTIPLIER, UTXO_TRACKER_MAX_LAG_BLOCKS);

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

const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: parseInt(process.env.ENCODER_RATE_LIMIT_RPM, 10) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Too many requests' } }
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

// CORS configuration (default: disabled; `*` allows all; a comma-separated list
// is an ALLOWLIST matched per-origin). parseCorsOrigin is what makes the list
// case work: handing `cors` the raw string would echo it verbatim to everyone
// and be accepted by no browser. See src/corsOrigin.js.
app.use(cors({ origin: parseCorsOrigin(CORS_ORIGIN) }));

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

// Serve-readiness probe shared by the JSON-RPC health() method and GET
// /status, so the two endpoints can never drift apart: probes the
// UTXO tracker and returns its reachability / sync state. Fields:
// tracker_reachable (bool), tracker_synced (bool), tracker_lag (number|null),
// tracker_halted (bool), tracker_mempool_ready (bool), maintenance (object|null).
//
// maintenance is the operator's DECLARED scheduled-outage window (see
// src/maintenanceWindow.js), carried alongside the readiness fields and never
// folded into them: it cannot make an unready encoder read ready, and it does
// not move the 503. A planned tracker stop and a broken tracker are the same
// readiness verdict - the difference is only that somebody meant one of them,
// which is exactly the distinction the public board had no way to draw.
//
// tracker_synced is SERVE-readiness, not the tracker's raw verdict: it
// applies the same maxUtxoTrackerLagBlocks ceiling create_tx enforces
// (deliberately tighter than the tracker's own SYNCED_THRESHOLD, money
// safety). Without the extra gate a 3-block lag read synced:true here while
// create_tx refused UTXO_TRACKER_STALE, so the status board painted Online
// on an un-serveable encoder. Null lag fails open, exactly like
// create_tx's overLag gate.
//
// A halted tracker (stopped polling on an unrecoverable reorg) and a negative
// lag (its committed tip sits above the node's, so its outputs are orphaned)
// are both un-serveable regardless of what `synced` says, and both were painting
// Online here because only the upper lag bound was checked. A tracker whose
// mempool has not reconverged is un-serveable for the same reason: create_tx
// refuses it UTXO_TRACKER_NOT_READY, so leaving it out of this probe recreated
// the same board-versus-encoder divergence the probe exists to prevent.
async function getServeReadiness() {
    // Read first and independently of the tracker probe: the window is what
    // explains a tracker that is deliberately down, so it must survive the
    // catch below rather than depend on the probe it annotates.
    const maintenance = await readMaintenanceWindow()
    let tracker_reachable = false
    let tracker_synced = false
    let tracker_lag = null
    let tracker_halted = false
    let tracker_mempool_ready = false
    try {
        const status = await encoder.utxoTrackerConnector.getSyncStatus()
        tracker_reachable = true
        const lag = status.lag !== undefined ? status.lag : null
        const overLag = (lag !== null) && (lag > encoder.maxUtxoTrackerLagBlocks)
        const behindNode = (lag !== null) && (lag < 0)
        tracker_halted = status.halted === true
        // Strict === false, matching create_tx's gate: a pre-mempool_ready tracker omits
        // the field and stays on the existing fail-open path rather than reading unready.
        tracker_mempool_ready = status.mempool_ready !== false
        tracker_synced = !!status.synced && !overLag && !behindNode && !tracker_halted && tracker_mempool_ready
        tracker_lag = lag
    } catch (_err) {
        // tracker unreachable; fields stay at defaults
    }
    return { tracker_reachable, tracker_synced, tracker_lag, tracker_halted, tracker_mempool_ready, maintenance }
}

const jsonRpcController = {
    async ping() {
        return {status:"success", version: ENCODER_VERSION};
    },
    // Probes hard dependencies (UTXO tracker) and returns their reachability /
    // sync state. Unlike ping, a health failure means the encoder cannot serve
    // requests correctly. See getServeReadiness() for the readiness gate,
    // shared with GET /status below.
    async health() {
        return getServeReadiness()
    },
    // Suggested fee tiers (base-unit per vByte: sat/koinu/litoshi) from the node's
    // estimatesmartfee at decreasing confirmation targets: low=slow/cheap (6
    // blocks) … high=next block (1). getFeePerKilobyte returns coin/kB; *1e5
    // converts to base-unit/byte (1e8 base-units per coin ÷ 1000 bytes per kB).
    // Floored at 1 so a tier is never 0. Read-only; no params.
    async estimate_fee() {
        const targets = { low: 6, medium: 3, high: 1 };
        const out = {};
        // Same test-chain ceiling createTx applies to a caller who supplies no
        // rate, so the quote matches what the build would actually charge.
        const capPerByte = XChainEncoder.suggestedFeeCeilingPerByte(NETWORK, 100000000);
        const capPerVbyte = capPerByte == null ? null : Math.max(1, Math.round(capPerByte * 100000000));
        try {
            for (const tier of Object.keys(targets)) {
                const feerate = await encoder.connector.getFeePerKilobyte(targets[tier]); // coin/kB
                let perVbyte = Math.max(1, Math.round(Number(feerate) * 100000));         // -> base-unit/byte
                if (capPerVbyte != null && perVbyte > capPerVbyte) perVbyte = capPerVbyte;
                out[tier] = perVbyte;
            }
        } catch (err) {
            console.error('Fee estimation error:', err)
            const e = new Error('Fee estimation failed')
            e.code = -32603
            throw e
        }
        return out;
    },
    async create_tx(rawParams) {
        let params
        try {
            params = validator.validateAll(rawParams)
        } catch (err) {
            const e = new Error(err.message)
            e.code = -32602
            throw e
        }

        let psbt
        try {
            psbt = await encoder.createTransaction(
                params.utxos, params.pubkey, params.customOutputs,
                params.data, params.rawData, params.fee, params.rbf,
                params.encoding, params.change, params.p2shHash, params.p2shHex,
                params.compressedPubKey, params.unconfirmed, params.feePerKb, params.dust,
                params.feeQuote, params.attachPrevTx, params.compress, params.options)
        } catch (err) {
            // Typed operational errors (no UTXOs, insufficient funds, missing
            // change address, tracker unavailable) are expected, caller-actionable
            // conditions with an encoder-authored, credential-free message and a
            // stable machine-readable code. Forward those so the wallet/SDK can
            // branch on them: message passes through and `xchainCode` (plus any
            // details payload) rides in the JSON-RPC error `data.reason`.
            if (err && err.operational === true) {
                const e = new Error(err.message)
                e.code = -32010
                e.data = Object.assign({ reason: err.xchainCode }, err.details || {})
                throw e
            }
            // Validation errors (TypeError/RangeError) carry safe messages from
            // our own validation. Everything else is an unexpected internal and is
            // collapsed to a generic message to prevent leaking internals
            // (host:port, stack, RPC credentials).
            const isKnown = err instanceof TypeError || err instanceof RangeError
            if (!isKnown) {
                console.error('Encoder error:', err)
            }
            const e = new Error(isKnown ? err.message : 'Internal encoder error')
            e.code = -32603
            throw e
        }

        psbt["psbt"] = psbt["psbt"].toHex()
        // TAPROOT envelope: one call returns the {commit, reveal}
        // pair; the caller signs both and broadcasts commit then reveal.
        if (psbt["revealPsbt"]) {
            psbt["revealPsbt"] = psbt["revealPsbt"].toHex()
        }
        return psbt;
    },
    // Key-path cancel of an unrevealed TAPROOT envelope commit: rebuilds the
    // sweep PSBT from the wallet's persisted recovery
    // record alone. Validation lives in the encoder method (typed
    // TypeError/RangeError -> -32602, OperationalError -> -32010).
    async create_envelope_cancel_tx(rawParams) {
        // Array.isArray for the same reason validator.validateAll carries it:
        // positional params otherwise clear the gate and destructure to undefined.
        if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
            const e = new Error('Request params must be an object')
            e.code = -32602
            throw e
        }
        let result
        try {
            result = await encoder.createEnvelopeCancelTransaction(rawParams)
        } catch (err) {
            if (err && err.operational === true) {
                const e = new Error(err.message)
                e.code = -32010
                e.data = Object.assign({ reason: err.xchainCode }, err.details || {})
                throw e
            }
            const isKnown = err instanceof TypeError || err instanceof RangeError
            if (!isKnown) {
                console.error('Encoder error:', err)
            }
            const e = new Error(isKnown ? err.message : 'Internal encoder error')
            e.code = isKnown ? -32602 : -32603
            throw e
        }
        result.psbt = result.psbt.toHex()
        return result
    },
    async broadcast_tx(rawParams) {
        let tx_hex = rawParams && rawParams.tx_hex
        if (!tx_hex) {
            const e = new Error('Missing required parameter: tx_hex')
            e.code = -32602
            throw e
        }
        // Shed malformed/oversized payloads before the node round-trip; the
        // node would reject them anyway, this just answers with a precise
        // invalid-params reason instead of a node-side parse error.
        try {
            validator.validateRawTxHex(tx_hex)
        } catch (err) {
            const e = new Error(err.message)
            e.code = -32602
            throw e
        }

        try {
            let txid = await encoder.connector.sendRawTransaction(tx_hex)
            return { txid: txid }
        } catch (err) {
            console.error('Broadcast error:', err)
            const e = new Error(upstreamErrorMessage(err, 'Transaction broadcast failed'))
            e.code = -32603
            throw e
        }
    },
    async get_utxos(rawParams) {
        let address = rawParams && rawParams.address
        if (!address) {
            const e = new Error('Missing required parameter: address')
            e.code = -32602
            throw e
        }
        // Shed non-string / oversized addresses with a precise invalid-params
        // reason before handing the value to the UTXO tracker.
        try {
            validator.validateAddress(address)
        } catch (err) {
            const e = new Error(err.message)
            e.code = -32602
            throw e
        }

        try {
            let result = await encoder.utxoTrackerConnector.getUtxosFromAddress(address)
            return result
        } catch (err) {
            console.error('UTXO fetch error:', err)
            const e = new Error(upstreamErrorMessage(err, 'UTXO fetch failed'))
            e.code = -32603
            throw e
        }
    }
}

// GET /status: returns 200 when the encoder's hard dependencies are reachable
// and the UTXO tracker is synced, or 503 when not. Distinct from the JSON-RPC
// `health` method so load-balancer / uptime monitors can rely on the HTTP status
// code directly (the JSON-RPC catch-all routes all GETs to 200 today). Shares
// the readiness gate with health() via getServeReadiness() above so
// the two endpoints cannot drift apart.
app.get('/status', async (req, res) => {
    // tracker_halted and tracker_mempool_ready travel alongside so the board names WHY
    // an unhealthy encoder is unhealthy; both already fold into tracker_synced above.
    const { tracker_reachable, tracker_synced, tracker_lag, tracker_halted, tracker_mempool_ready, maintenance } = await getServeReadiness()
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
})

// Machine-readable API spec (OpenRPC 1.3.2). Regenerated by docs/openrpc.build.js;
// test/unit/openrpc-coverage.test.js keeps it in lockstep with jsonRpcController.
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
app.use(jsonRouter({methods: jsonRpcController}))


// Start the server only when run directly (node src/api.js). When required by a
// test the controller and app are exported without binding a port.
if (require.main === module) {
  // HARD deploy constraint: the outpoint-reservation double-spend guard and the
  // rate limiter are in-process, so exactly ONE encoder instance may serve an
  // endpoint. Fail at boot if the deploy declares replicas > 1 (ENCODER_REPLICAS)
  // or another encoder process on this host already holds the instance lock.
  // See src/singleInstanceGuard.js.
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
