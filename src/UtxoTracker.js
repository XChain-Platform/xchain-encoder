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
 * XChain Encoder - UTXO Tracker Class
 * 
 * This file handles getting UTXO information from an xchain-utxo-tracker instance
 * 
 ********************************************************************/

// Load required libraries
const fetch = require('cross-fetch')

class UtxoTracker {
    constructor(url, port) {
        this.url = "http://"+url+":"+port
        this.port = port
    }
    
    async getUtxosFromAddress(address) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'get_utxos',
                params: { address: address },
                id: 1
            };

            // Options configuration for fetch
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            };

            // Make the request to the node
            const response = await fetch(this.url, options);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify if there is a result and return it
            if (responseData.result) {
                return responseData.result;
            } else {
                throw new Error('Error getting utxos');
            }
        } catch (error) {
            console.error('Error fetching UTXOs:', error.message);
            throw error;
        }
    }
}

module.exports = UtxoTracker