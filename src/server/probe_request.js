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
 **********************************************************************/

'use strict'

// Match every request Express routes to the GET /status and GET /openrpc.json
// handlers: HEAD dispatches to the GET route, and default routing is neither
// strict nor case-sensitive. A narrower predicate lets a probe run while the
// main gate holds its slot, so it can be shed with 429 and probeGate.hold()
// finds no slot of its own to keep.
const PROBE_PATH = /^\/(status|openrpc\.json)\/?$/i

/**
 * @param {{method: string, path: string}} req
 * @returns {boolean} true when the request belongs to the probe reserve
 */
function isProbe (req) {
    return (req.method === 'GET' || req.method === 'HEAD') && PROBE_PATH.test(req.path)
}

module.exports = { isProbe, PROBE_PATH }
