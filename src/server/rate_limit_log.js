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
 * Security: rate-limit refusal counter/logger
 *
 * express-rate-limit sets the draft-6 RateLimit-* and Retry-After headers
 * and picks the status/body before calling a custom `handler`, so `message`
 * moves here and the handler sends it itself. A line per refusal would
 * flood the log under real abuse, so this logs once at the first refusal
 * of a window and again at the first refusal after a full windowMs has
 * elapsed since that line, carrying how many refusals happened since. The
 * count only advances on an actual refusal (no timer/interval), so an idle
 * limiter never holds the process open.
 *
 ********************************************************************/

'use strict'

function limitedHandler({ service, name, envVar, limit, windowMs, message, log = console.warn, now = Date.now }) {
    const windowSeconds = Math.round(windowMs / 1000)
    let count = 0
    let lastLogAt = null

    return function (req, res, next, options) {
        res.status(429).json(message)

        count++
        const ts = now()
        const dueForLog = lastLogAt === null || (ts - lastLogAt >= windowMs)
        if (dueForLog) {
            const n = count
            log(`${service} rate limit [${name}]: ${n} request${n === 1 ? '' : 's'} refused in the last ${windowSeconds} s (limit ${limit}/${windowSeconds} s); raise ${envVar} if this is legitimate traffic`)
            count = 0
            lastLogAt = ts
        }
    }
}

module.exports = { limitedHandler }
