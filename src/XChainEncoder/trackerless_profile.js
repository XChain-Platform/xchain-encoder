'use strict';

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
 * UTXO_TRACKER_PROFILE
 *
 * 'default' keeps the historical behaviour: a tracker that predates the
 * freshness surface fails open. 'remote' makes a remote tracker mandatory and
 * fails closed: every missing or negative freshness signal refuses with a typed
 * error instead of selecting from a view nobody vouched for.
 *
 ********************************************************************/

const { OperationalError } = require('../build/errors')
const { upstreamErrorMessage } = require('../common/error_sanitize')
const { classifyTrackerFreshness } = require('./request_resolution.js')

const PROFILE_DEFAULT = 'default'
const PROFILE_REMOTE = 'remote'

function resolveTrackerProfile(raw){
    if (raw == null || String(raw).trim() === '') return PROFILE_DEFAULT
    const profile = String(raw).trim().toLowerCase()
    if (profile === PROFILE_DEFAULT || profile === PROFILE_REMOTE) return profile
    throw new Error(`UTXO_TRACKER_PROFILE must be "${PROFILE_DEFAULT}" or "${PROFILE_REMOTE}" (got ${JSON.stringify(String(raw))})`)
}

function isRemoteProfile(profile){
    return profile === PROFILE_REMOTE
}

function assertRemoteTrackerConfigured(profile, url, port){
    if (!isRemoteProfile(profile)) return
    const missing = []
    if (url == null || String(url).trim() === '') missing.push('UTXO_TRACKER_URL')
    if (port == null || String(port).trim() === '') missing.push('UTXO_TRACKER_API_PORT')
    if (missing.length){
        throw new OperationalError('UTXO_TRACKER_NOT_CONFIGURED',
            `UTXO_TRACKER_PROFILE=remote requires ${missing.join(' and ')}`, { missing })
    }
}

function trackerUnreachableError(err){
    return new OperationalError('UTXO_TRACKER_UNREACHABLE',
        upstreamErrorMessage(err, 'utxo-tracker is unreachable; the remote profile has no fallback'))
}

function trackerSyncMissingError(){
    return new OperationalError('UTXO_TRACKER_SYNC_MISSING',
        'utxo-tracker did not report its sync state; the remote profile refuses an unattested view')
}

// The remote profile's verdict on one `sync` payload: a missing payload, a
// missing or non-numeric lag and an absent positive `synced` are all refusals.
// Returns the shared classifier's verdict when it refuses, else null.
function classifyRemoteSync(profile, sync, maxLagBlocks){
    const verdict = classifyTrackerFreshness(sync, maxLagBlocks)
    if (!isRemoteProfile(profile)) return verdict.code ? verdict : null
    if (!verdict.present || verdict.lag === null){
        const err = trackerSyncMissingError()
        return { code: err.xchainCode, message: err.message, details: null }
    }
    if (verdict.code) return verdict
    if (!verdict.syncedClaimed){
        const err = new OperationalError('UTXO_TRACKER_STALE',
            'utxo-tracker did not assert that it is synced; refusing to select utxos from it')
        return { code: err.xchainCode, message: err.message, details: { lag: verdict.lag } }
    }
    return null
}

function throwIfRefused(profile, sync, maxLagBlocks){
    const refusal = classifyRemoteSync(profile, sync, maxLagBlocks)
    if (refusal) throw new OperationalError(refusal.code, refusal.message, refusal.details || undefined)
}

module.exports = {
    PROFILE_DEFAULT, PROFILE_REMOTE, resolveTrackerProfile, isRemoteProfile,
    assertRemoteTrackerConfigured, trackerUnreachableError, trackerSyncMissingError,
    classifyRemoteSync, throwIfRefused
}
