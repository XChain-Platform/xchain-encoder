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
 * of a burst, then once per windowMs while refusals keep coming, each line
 * carrying how many refusals happened since the previous one.
 *
 * Refusals after a line are flushed by a one-shot timer at the end of that
 * line's window. Without it the last refusals of a burst were never logged,
 * and the next refusal, maybe hours later, folded them into a line spanning
 * the whole gap. The timer is armed only while refusals are pending and is
 * unref()'d, so an idle limiter never holds the process open. A refusal that
 * starts a new burst (nothing pending, window over) logs as a fresh window.
 *
 ********************************************************************/

'use strict'

function limitedHandler({ service, name, envVar, limit, windowMs, message, log = console.warn, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const windowSeconds = Math.round(windowMs / 1000)
    let count = 0
    let lastLogAt = null
    let timer = null

    function writeLine(n, spanSeconds, ts) {
        log(`${service} rate limit [${name}]: ${n} request${n === 1 ? '' : 's'} refused in the last ${spanSeconds} s (limit ${limit}/${windowSeconds} s); raise ${envVar} if this is legitimate traffic`)
        count = 0
        lastLogAt = ts
    }

    // End of a line's window: report what was refused since that line, so
    // the refusals of a burst's tail are logged even if no refusal follows.
    function flushPending() {
        timer = null
        if (count === 0) return
        const ts = now()
        writeLine(count, Math.round((ts - lastLogAt) / 1000), ts)
    }

    return function (req, res, next, options) {
        res.status(429).json(message)

        const pendingBefore = count
        count++
        const ts = now()
        const dueForLog = lastLogAt === null || (ts - lastLogAt >= windowMs)
        if (dueForLog) {
            if (timer !== null) {
                clearTimer(timer)
                timer = null
            }
            // Nothing pending means the flush already covered the previous
            // window, so this refusal opens a new one rather than spanning
            // the idle gap. Pending refusals here mean the flush has not run
            // yet, so the line covers the real span since the last line.
            const spanSeconds = (lastLogAt === null || pendingBefore === 0) ? windowSeconds : Math.round((ts - lastLogAt) / 1000)
            writeLine(count, spanSeconds, ts)
        } else if (timer === null) {
            timer = setTimer(flushPending, Math.max(1, lastLogAt + windowMs - ts))
            if (timer && typeof timer.unref === 'function') timer.unref()
        }
    }
}

module.exports = { limitedHandler }
