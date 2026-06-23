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

const bitcoin = require('bitcoinjs-lib');
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const XChainEncoder  = require('./XChainEncoder');
const jsonRouter = require('express-json-rpc-router')
const validator = require('./validator')
const { upstreamErrorMessage } = require('./errorSanitize')
const { version: ENCODER_VERSION } = require('../package.json')


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
const API_KEY = process.env.API_KEY
const CORS_ORIGIN = process.env.CORS_ORIGIN

// API key authentication is OPTIONAL (see components/encoder/README.md, default: Disabled).
// When API_KEY is unset the encoder runs open; setting it opts into x-api-key enforcement.
if (!API_KEY) {
    console.warn('NOTICE: API_KEY not set. Encoder API authentication is DISABLED (open access).')
}

const encoder = new XChainEncoder(NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, UTXO_TRACKER_URL, UTXO_TRACKER_API_PORT, MAX_FEE_RATE_KB, MAX_FEE_RATE_MULTIPLIER);

const app = express();

app.use(helmet());

app.use(bodyParser.json({ limit: '1mb' }));

// API key authentication (only enforced when API_KEY is configured).
if (API_KEY) {
    app.use((req, res, next) => {
        // The machine-readable spec stays public even on keyed deploys.
        if (req.method === 'GET' && req.path === '/openrpc.json') return next()
        const key = req.headers['x-api-key']
        if (key !== API_KEY) {
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

// CORS configuration (default: disabled; set CORS_ORIGIN=* to allow all)
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN } : { origin: false }));


const jsonRpcController = {
    async ping() {
        return {status:"success", version: ENCODER_VERSION};
    },
    // Probes hard dependencies (UTXO tracker) and returns their reachability /
    // sync state. Unlike ping, a health failure means the encoder cannot serve
    // requests correctly. Fields: tracker_reachable (bool), tracker_synced
    // (bool), tracker_lag (number|null).
    async health() {
        let tracker_reachable = false
        let tracker_synced = false
        let tracker_lag = null
        try {
            const status = await encoder.utxoTrackerConnector.getSyncStatus()
            tracker_reachable = true
            tracker_synced = !!status.synced
            tracker_lag = status.lag !== undefined ? status.lag : null
        } catch (_err) {
            // tracker unreachable; fields stay at defaults
        }
        return { tracker_reachable, tracker_synced, tracker_lag }
    },
    // Suggested fee tiers (base-unit per vByte: sat/koinu/litoshi) from the node's
    // estimatesmartfee at decreasing confirmation targets: low=slow/cheap (6
    // blocks) … high=next block (1). getFeePerKilobyte returns coin/kB; *1e5
    // converts to base-unit/byte (1e8 base-units per coin ÷ 1000 bytes per kB).
    // Floored at 1 so a tier is never 0. Read-only; no params.
    async estimate_fee() {
        const targets = { low: 6, medium: 3, high: 1 };
        const out = {};
        try {
            for (const tier of Object.keys(targets)) {
                const feerate = await encoder.connector.getFeePerKilobyte(targets[tier]); // coin/kB
                out[tier] = Math.max(1, Math.round(Number(feerate) * 100000));            // -> base-unit/byte
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
                params.feeQuote)
        } catch (err) {
            // Sanitize: TypeError/RangeError messages are safe (from our validation);
            // all others get a generic message to prevent internal info leakage
            const isKnown = err instanceof TypeError || err instanceof RangeError
            if (!isKnown) {
                console.error('Encoder error:', err)
            }
            const e = new Error(isKnown ? err.message : 'Internal encoder error')
            e.code = -32603
            throw e
        }

        psbt["psbt"] = psbt["psbt"].toHex()
        return psbt;
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
    // Function to fetch UTXOs for an address (proxies to UTXO tracker)
    async get_utxos(rawParams) {
        let address = rawParams && rawParams.address
        if (!address) {
            const e = new Error('Missing required parameter: address')
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
// code directly (the JSON-RPC catch-all routes all GETs to 200 today).
app.get('/status', async (req, res) => {
    let tracker_reachable = false
    let tracker_synced = false
    let tracker_lag = null
    try {
        const status = await encoder.utxoTrackerConnector.getSyncStatus()
        tracker_reachable = true
        tracker_synced = !!status.synced
        tracker_lag = status.lag !== undefined ? status.lag : null
    } catch (_err) {
        // tracker unreachable; fields stay at defaults
    }
    const healthy = tracker_reachable && tracker_synced
    const code = healthy ? 200 : 503
    res.status(code).json({ status: healthy ? 'healthy' : 'unhealthy', tracker_reachable, tracker_synced, tracker_lag })
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

// Allow JSON-RPC requests
app.use(jsonRouter({methods: jsonRpcController}))


// Start the server
app.listen(ENCODER_API_PORT, () => {
  console.log('API listening on port '+ENCODER_API_PORT);
});
