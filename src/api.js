/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Encoder - API
 *
 * This file parses in environmental variables and starts up the encoder instance
 *
 ********************************************************************/

// Load required libraries
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


const NETWORK = process.env.NETWORK
const NODE_URL = process.env.NODE_URL
const NODE_PORT = process.env.NODE_PORT
const NODE_USER = process.env.NODE_USER
const NODE_PASSWORD = process.env.NODE_PASSWORD
const UTXO_TRACKER_URL = process.env.UTXO_TRACKER_URL
const UTXO_TRACKER_API_PORT = process.env.UTXO_TRACKER_API_PORT
const ENCODER_API_PORT = process.env.ENCODER_API_PORT
const MAX_FEE_RATE_KB = process.env.MAX_FEE_RATE_KB ? parseInt(process.env.MAX_FEE_RATE_KB, 10) : null
const API_KEY = process.env.API_KEY
const CORS_ORIGIN = process.env.CORS_ORIGIN

// API key authentication is OPTIONAL (see components/encoder/README.md — default Disabled).
// When API_KEY is unset the encoder runs open; setting it opts into x-api-key enforcement.
if (!API_KEY) {
    console.warn('NOTICE: API_KEY not set — encoder API authentication is DISABLED (open access).')
}

const encoder = new XChainEncoder(NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, UTXO_TRACKER_URL, UTXO_TRACKER_API_PORT, MAX_FEE_RATE_KB);

// Create the app
const app = express();

// Use Helmet to increase security
app.use(helmet());

// Allow JSON requests with size limit
app.use(bodyParser.json({ limit: '1mb' }));

// API key authentication — only enforced when API_KEY is configured.
if (API_KEY) {
    app.use((req, res, next) => {
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

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.ENCODER_RATE_LIMIT_RPM, 10) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Too many requests' } }
})
app.use(limiter)

// CORS configuration (default: disabled; set CORS_ORIGIN=* to allow all)
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN } : { origin: false }));


const jsonRpcController = {
    // Function to check if xchain-indexer is up
    async ping() {
        return {status:"success"};
    },
    // Function to create transactions hex for a given data and encoding type
    async create_tx(rawParams) {
        // Validate and sanitize all parameters
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

        // Return the transaction
        return psbt;
    },
    // Function to broadcast a signed transaction to the coin node
    async broadcast_tx(rawParams) {
        let tx_hex = rawParams && rawParams.tx_hex
        if (!tx_hex) {
            const e = new Error('Missing required parameter: tx_hex')
            e.code = -32602
            throw e
        }

        try {
            let txid = await encoder.connector.sendRawTransaction(tx_hex)
            return { txid: txid }
        } catch (err) {
            console.error('Broadcast error:', err)
            const e = new Error(err.message || 'Transaction broadcast failed')
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
            const e = new Error(err.message || 'UTXO fetch failed')
            e.code = -32603
            throw e
        }
    }
}

// Allow JSON-RPC requests
app.use(jsonRouter({methods: jsonRpcController}))


// Start the server
app.listen(ENCODER_API_PORT, () => {
  console.log('API listening on port '+ENCODER_API_PORT);
});
