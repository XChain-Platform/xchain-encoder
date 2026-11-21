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

const { getLogger } = require('../observability')

const DEFAULT_API_PORT = 3000
const PORT_ERROR = 'ENCODER_API_PORT must be a decimal integer from 0 to 65535'

// Unset means the documented default; anything set must be a whole port number,
// so a typo refuses to boot instead of binding a random port.
function resolveApiPort(value) {
    if (value == null || value === '') return DEFAULT_API_PORT
    if (!/^\d+$/.test(value)) throw new Error(PORT_ERROR + ' (got ' + JSON.stringify(value) + ')')
    const port = Number(value)
    if (!Number.isSafeInteger(port) || port > 65535) throw new Error(PORT_ERROR + ' (got ' + value + ')')
    return port
}

// Express 5 hands a bind failure (EADDRINUSE, EACCES) to the listen callback as
// its error listener. Rethrowing it turns the failure into an uncaughtException,
// so the installed crash handler writes one CRASH record and exits 1 instead of
// the process logging success and exiting 0.
function listenOrCrash(app, port) {
    const server = app.listen(port, (err) => {
        if (err) throw err
        getLogger().info('API listening on port ' + server.address().port)
    })
    return server
}

module.exports = { DEFAULT_API_PORT, resolveApiPort, listenOrCrash }
