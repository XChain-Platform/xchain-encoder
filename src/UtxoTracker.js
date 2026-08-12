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
            // Halt is a verdict the tracker publishes independently of `synced`: it
            // has stopped polling on an unrecoverable reorg and its store is frozen,
            // possibly mid-rollback. A frozen height whose lag still looked acceptable
            // sailed past both checks below, so gate on it first ().
            if (syncStatus.halted === true) {
                throw new Error(`utxo-tracker is halted (${syncStatus.halt_reason || 'unrecoverable reorg'}); refusing to fetch UTXOs`)
            }
            // A negative lag means our committed tip is ABOVE the node's, i.e. the node
            // reset or reindexed below us and those outputs sit in blocks it no longer
            // recognizes. Checked here as well as at the tracker so an un-upgraded
            // tracker still reporting synced:true cannot authorize selection over
            // orphaned UTXOs (, the fail-open boundary's own guard).
            if (lag < 0) {
                throw new Error(`utxo-tracker is ${-lag} blocks ahead of the node (node reset or reorged below its tip); refusing to fetch UTXOs`)
            }
            // Delegate the sync verdict to the tracker, which computes `synced`
            // against its own authoritative threshold. Avoids drift from keeping
            // a local copy of the threshold here.
            if (!syncStatus.synced) {
                throw new Error(`utxo-tracker is lagging by ${lag} blocks; refusing to fetch UTXOs`)
            }
            // Block sync flips true before the first mempool rebuild finishes, and until
            // it does the empty mempool index cannot filter a confirmed output already
            // spent in the node's mempool, so the fetch hands back unspendable inputs.
            // Same refusal create_tx makes as UTXO_TRACKER_NOT_READY; strict === false
            // keeps a tracker predating the field on the fail-open path ().
            // Ordered LAST of the three, most specific cause first, exactly as
            // XChainEncoder.js orders its own gates: get_sync_status derives
            // mempool_ready as `synced && isMempoolReconverged()`, so a merely
            // lagging tracker de-asserts it too, and checking it first blamed
            // mempool reconvergence for a fault that is really block lag.
            if (syncStatus.mempool_ready === false) {
                throw new Error('utxo-tracker has not reconverged its mempool yet, so an already-spent confirmed output cannot be filtered; refusing to fetch UTXOs')
            }
        } catch (error) {
            console.error('Error checking UTXO tracker sync status:', error);
            throw error;
        }

        // Paginate to handle addresses with more UTXOs than the tracker's
        // MAX_ADDRESS_OUTPUTS limit. Each page passes limit=10000 and threads
        // the nextCursor from the previous response via an `after` param until
        // the tracker signals no more pages by returning an empty/absent cursor.
        const PAGE_LIMIT = 10000
        // Backstop against a buggy/hostile/MITM'd tracker that never terminates pagination
        // (always returns a non-empty nextCursor, or cycles the same cursor): without a bound
        // the while(true) loop threads forever and allUtxos grows until the encoder OOMs on a
        // single request. MAX_PAGES * PAGE_LIMIT (10M utxos) is far beyond any real address; a
        // repeated cursor is treated as an immediate stall.
        const MAX_PAGES = 1000
        const allUtxos = []
        const seenCursors = new Set()
        let cursor = undefined
        let pageCount = 0
        try {
            while (true) {
                if (++pageCount > MAX_PAGES) {
                    throw new Error(`utxo-tracker returned more than ${MAX_PAGES} pages for ${address}; aborting (buggy or hostile tracker)`)
                }
                const params = { address, limit: PAGE_LIMIT }
                if (cursor !== undefined) {
                    params.after = cursor
                }

                const data = {
                    jsonrpc: '2.0',
                    method: 'get_utxos',
                    params,
                    id: 1
                };

                // Make the request to the node
                const response = await axios.post(this.url, data, {
                    timeout: TRACKER_TIMEOUT
                });

                const responseData = response.data;

                // Verify structure or surface the tracker's structured error.
                if (responseData.result && typeof responseData.result === 'object' && responseData.result !== null) {
                    const result = responseData.result
                    if (!Array.isArray(result.utxos)) {
                        throw new TypeError('UTXO tracker result missing utxos array')
                    }
                    // pageOffset is the count before this page so globalIdx
                    // across pages matches what a single-page caller would see.
                    const pageOffset = allUtxos.length
                    for (let i = 0; i < result.utxos.length; i++) {
                        const u = result.utxos[i]
                        const globalIdx = pageOffset + i
                        if (typeof u !== 'object' || u === null ||
                            typeof u.txid !== 'string' ||
                            typeof u.vout === 'undefined' ||
                            typeof u.value === 'undefined') {
                            throw new TypeError(`UTXO tracker returned malformed utxo at index ${globalIdx}`)
                        }
                        if (!HEX_64_RE.test(u.txid)) {
                            throw new TypeError(`UTXO tracker returned malformed utxo at index ${globalIdx}: txid must be a 64-character hex string`)
                        }
                        if (typeof u.scriptPubKey !== 'string' || u.scriptPubKey.length === 0) {
                            throw new TypeError(`UTXO tracker returned malformed utxo at index ${globalIdx}: scriptPubKey must be a non-empty string`)
                        }
                        if (u.confirmations == null) {
                            u.confirmations = 0
                        } else {
                            // Mirror validateUtxoEntry: the encoder's unconfirmed
                            // filter compares `confirmations == 0` loosely, so
                            // coerce and range-check tracker-supplied values too.
                            const confirmations = Number(u.confirmations)
                            if (!Number.isInteger(confirmations) || confirmations < 0) {
                                throw new TypeError(`UTXO tracker returned malformed utxo at index ${globalIdx}: confirmations must be a non-negative integer`)
                            }
                            u.confirmations = confirmations
                        }
                        allUtxos.push(u)
                    }

                    // Continue only if the tracker signals another page.
                    const nextCursor = result.nextCursor
                    if (nextCursor) {
                        // A repeated cursor means the tracker is cycling/stalled: abort rather
                        // than loop forever accumulating the same pages.
                        if (seenCursors.has(nextCursor)) {
                            throw new Error(`utxo-tracker returned a repeated pagination cursor for ${address}; aborting (stalled or hostile tracker)`)
                        }
                        seenCursors.add(nextCursor)
                        cursor = nextCursor
                    } else {
                        // No more pages; return accumulated result with utxos merged.
                        return { ...result, utxos: allUtxos }
                    }
                } else {
                    // Surface the structured error the tracker returned (e.g. ADDRESS_TOO_LARGE,
                    // INVALID_CURSOR) rather than discarding it. The tracker maps these to
                    // meaningful error codes/messages at the JSON-RPC layer; losing them here
                    // makes the operator see the same opaque message for every failure mode.
                    // Prefer err.data.code (string code forwarded by the tracker) over err.code.
                    const rpcError = responseData.error
                    if (rpcError && (rpcError.message || rpcError.code || rpcError.data?.code)) {
                        const code = rpcError.data?.code || rpcError.code
                        throw new Error(`Error getting utxos: ${code ? `[${code}] ` : ''}${rpcError.message || 'unknown error'}`)
                    }
                    throw new Error('Error getting utxos: empty result')
                }
            }
        } catch (error) {
            console.error('Error fetching UTXOs:', error);
            throw error;
        }
    }
}

module.exports = UtxoTracker
