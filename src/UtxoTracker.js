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
 * XChain Encoder - UTXO Tracker Class
 *
 * This file handles getting UTXO information from an xchain-utxo-tracker instance
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios')

// How long to wait on the tracker before giving up on a request.
const TRACKER_TIMEOUT = 15000

// A valid on-chain txid is exactly 64 hex characters. The tracker can emit a
// shorter zero-hash sentinel in edge cases; reject it here rather than letting
// it reach bitcoinjs-lib's psbt.addInput() and throw at construction time.
const HEX_64_RE = /^[0-9a-fA-F]{64}$/

class UtxoTracker {
    constructor(url, port) {
        this.url = "http://"+url+":"+port
        this.port = port
    }

    // Probe the tracker's lag behind the chain tip. Returns the parsed
    // get_sync_status result ({committed_height, tracker_height, node_height,
    // lag, synced}). `synced` is the tracker's own verdict (lag within its
    // threshold); callers should rely on it rather than re-deriving a local
    // threshold. Throws on transport/HTTP/shape errors so callers can treat an
    // unreachable or malformed status response as "do not proceed".
    async getSyncStatus() {
        const data = {
            jsonrpc: '2.0',
            method: 'get_sync_status',
            params: {},
            id: 1
        };

        const response = await axios.post(this.url, data, {
            timeout: TRACKER_TIMEOUT
        });

        const responseData = response.data;

        if (responseData.result && typeof responseData.result === 'object' && responseData.result !== null) {
            return responseData.result
        } else {
            throw new Error('Error getting sync status: empty result')
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
            // Delegate the sync verdict to the tracker, which computes `synced`
            // against its own authoritative threshold. Avoids drift from keeping
            // a local copy of the threshold here.
            if (!syncStatus.synced) {
                throw new Error(`utxo-tracker is lagging by ${lag} blocks; refusing to fetch UTXOs`)
            }
        } catch (error) {
            console.error('Error checking UTXO tracker sync status:', error);
            throw error;
        }

        try {
            const data = {
                jsonrpc: '2.0',
                method: 'get_utxos',
                params: { address: address },
                id: 1
            };

            // Make the request to the node
            const response = await axios.post(this.url, data, {
                timeout: TRACKER_TIMEOUT
            });

            const responseData = response.data;

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
                    if (!HEX_64_RE.test(u.txid)) {
                        throw new TypeError(`UTXO tracker returned malformed utxo at index ${i}: txid must be a 64-character hex string`)
                    }
                    if (typeof u.scriptPubKey !== 'string' || u.scriptPubKey.length === 0) {
                        throw new TypeError(`UTXO tracker returned malformed utxo at index ${i}: scriptPubKey must be a non-empty string`)
                    }
                    if (u.confirmations == null) {
                        u.confirmations = 0
                    }
                }
                return result
            } else {
                throw new Error('Error getting utxos: empty result')
            }
        } catch (error) {
            console.error('Error fetching UTXOs:', error);
            throw error;
        }
    }
}

module.exports = UtxoTracker
