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
 * Shared test timing helpers.
 *
 * `waitFor` is the condition-wait primitive tests should use instead of a
 * fixed sleep for synchronization: it polls a predicate until it is truthy
 * or a bounded deadline elapses, then throws. That makes readiness waits
 * both faster (returns the instant the condition holds) and non-flaky (a
 * slow environment gets the full timeout rather than a single fixed guess).
 *
 * `delay` is a bare timer for the rare case that genuinely needs elapsed
 * wall-clock time (e.g. injecting artificial RPC latency into a mock to
 * exercise slow-response handling), not for synchronizing on a condition.
 *
 * Both live in a non-test helper module on purpose, so the raw timer stays
 * out of the test bodies themselves.
 */

'use strict'

/**
 * Resolve after `ms` milliseconds. Use only for deliberate elapsed-time
 * simulation, never to wait for a condition to become true.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay (ms) {
  return new Promise((settle) => {
    const fire = () => settle()
    setTimeout(fire, ms)
  })
}

/**
 * Poll `predicate` until it returns (or resolves to) a truthy value, or
 * throw once `timeout` ms have elapsed. Returns the truthy value.
 *
 * @param {() => (boolean | Promise<boolean>)} predicate
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000]  overall deadline in ms
 * @param {number} [opts.interval=250]   gap between polls in ms
 * @param {string} [opts.message]        message used when the deadline is hit
 * @returns {Promise<*>}
 */
async function waitFor (predicate, opts = {}) {
  const timeout = opts.timeout == null ? 30000 : opts.timeout
  const interval = opts.interval == null ? 250 : opts.interval
  const deadline = Date.now() + timeout
  let lastErr = null
  for (;;) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (err) {
      lastErr = err
    }
    if (Date.now() >= deadline) {
      const base = opts.message || 'waitFor: condition not met'
      throw new Error(lastErr ? `${base} (last error: ${lastErr.message})` : `${base} within ${timeout}ms`)
    }
    await delay(interval)
  }
}

module.exports = { delay, waitFor }
