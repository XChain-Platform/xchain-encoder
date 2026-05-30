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

// Maximum number of blocks the tracker may trail the node tip before its UTXO
// view is considered too stale to build transactions against. Mirrors the
// tracker's own SYNCED_THRESHOLD: when lag exceeds this, the tracker reports
// itself out of sync and may be serving UTXOs that reflect an already-spent
// state, which would produce transactions the network rejects.
const SYNCED_THRESHOLD = 3

class UtxoTracker {
    constructor(url, port) {
        this.url = "http://"+url+":"+port
        this.port = port
    }

    // Probe the tracker's lag behind the chain tip. Returns the parsed
    // get_sync_status result ({committed_height, tracker_height, node_height,
    // lag}). Throws on transport/HTTP/shape errors so callers can treat an
    // unreachable or malformed status response as "do not proceed".
    async getSyncStatus() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);

        try {
            const data = {
                jsonrpc: '2.0',
                method: 'get_sync_status',
                params: {},
                id: 1
            };

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            };

            const response = await fetch(this.url, { ...options, signal: controller.signal });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseData = await response.json();

            if (responseData.result && typeof responseData.result === 'object' && responseData.result !== null) {
                return responseData.result
            } else {
                throw new Error('Error getting sync status: empty result')
            }
        } finally {
            clearTimeout(timer);
        }
    }

    async getUtxosFromAddress(address) {
        // Pre-flight: refuse to fetch UTXOs while the tracker is lagging the
        // chain tip. A stale UTXO view can select already-spent outputs and
        // produce transactions the network rejects, which would otherwise fail
        // silently. Converting this into an explicit, catchable error lets
        // callers (e.g. the oracle PRICE submission path) surface or retry.
        try {
            const syncStatus = await this.getSyncStatus()
            const lag = syncStatus.lag
            if (lag === null || typeof lag === 'undefined') {
                throw new Error('utxo-tracker has not indexed any blocks yet; refusing to fetch UTXOs')
            }
            if (lag > SYNCED_THRESHOLD) {
                throw new Error(`utxo-tracker is lagging by ${lag} blocks; refusing to fetch UTXOs`)
            }
        } catch (error) {
            console.error('Error checking UTXO tracker sync status:', error);
            throw error;
        }

        // Abort the request if the tracker does not respond within 15 seconds
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);

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
            const response = await fetch(this.url, { ...options, signal: controller.signal });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify structure and return result
            if (responseData.result && typeof responseData.result === 'object' && responseData.result !== null) {
                const result = responseData.result
                if (!Array.isArray(result.utxos)) {
                    throw new TypeError('UTXO tracker result missing utxos array')
                }
                for (let i = 0; i < result.utxos.length; i++) {
                    const u = result.utxos[i]
                    if (typeof u !== 'object' || u === null ||
                        typeof u.txid !== 'string' ||
                        typeof u.vout === 'undefined' ||
                        typeof u.value === 'undefined') {
                        throw new TypeError(`UTXO tracker returned malformed utxo at index ${i}`)
                    }
                }
                return result
            } else {
                throw new Error('Error getting utxos: empty result')
            }
        } catch (error) {
            console.error('Error fetching UTXOs:', error);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

module.exports = UtxoTracker