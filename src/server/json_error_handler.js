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

// Pick a fixed JSON-RPC body for a middleware error; err.message and err.stack never reach the caller.
function errorReply (err) {
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 500 ? err.status : 500
    if (status === 500) return { status, code: -32603, message: 'Internal error' }
    if (err.type === 'entity.parse.failed') return { status, code: -32700, message: 'Parse error' }
    return { status, code: -32600, message: status === 413 ? 'Request body too large' : 'Invalid Request' }
}

/**
 * Answer an error a middleware passed to next(err) (a malformed or oversized body) as JSON-RPC.
 * Mount it as the last app.use, so Express's default handler never serves a stack page.
 * @param {Error & {status?: number, type?: string}} err
 * @param {import('express').Request} req - unused; Express knows an error handler by its four parameters
 * @param {import('express').Response} res
 * @param {Function} next
 */
function jsonErrorHandler (err, req, res, next) {
    if (res.headersSent) return next(err)
    const reply = errorReply(err)
    if (reply.status === 500) getLogger().error('Unhandled API error: ' + ((err && err.stack) || err))
    return res.status(reply.status).json({ jsonrpc: '2.0', id: null, error: { code: reply.code, message: reply.message } })
}

module.exports = { jsonErrorHandler, errorReply }
