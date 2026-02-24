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
 * This software is provided “AS IS”, without warranties or conditions of any kind.
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
const XChainEncoder  = require('./XChainEncoder');
const jsonRouter = require('express-json-rpc-router')


const NETWORK = process.env.NETWORK
const NODE_URL = process.env.NODE_URL
const NODE_PORT = process.env.NODE_PORT
const NODE_USER = process.env.NODE_USER
const NODE_PASSWORD = process.env.NODE_PASSWORD
const UTXO_TRACKER_URL = process.env.UTXO_TRACKER_URL
const UTXO_TRACKER_API_PORT = process.env.UTXO_TRACKER_API_PORT
const ENCODER_API_PORT = process.env.ENCODER_API_PORT

const encoder = new XChainEncoder(NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, UTXO_TRACKER_URL, UTXO_TRACKER_API_PORT);

// Create the app
const app = express();

// Use Helmet to increase security
app.use(helmet());

// Allow JSON requests
app.use(bodyParser.json());

// Allow CORS for development
app.use(cors());


const jsonRpcController = {
    // Function to check if xchain-indexer is up
    async ping() {
        return {status:"success"};
    },
    // Function to create transactions hex for a given data and encoding type
    async create_tx({ 
        utxos, pubkey, customOutputs, data, rawData, fee, rbf, 
        encoding, change, p2shHash, p2shHex, compressedPubKey,
        unconfirmed, feePerKb, dust
    }) {
        // Create the transaction
        let psbt = await encoder.createTransaction(
            utxos, pubkey, customOutputs, data, rawData, 
            fee, rbf, encoding, change, p2shHash, p2shHex,
            compressedPubKey, unconfirmed, feePerKb, dust)
                                            
        psbt["psbt"] = psbt["psbt"].toHex()
        
        // Return the transaction
        return psbt;
    }
}

// Allow JSON-RPC requests
app.use(jsonRouter({methods: jsonRpcController}))


// Start the server
app.listen(ENCODER_API_PORT, () => {
  console.log('API listening on port '+ENCODER_API_PORT);
});