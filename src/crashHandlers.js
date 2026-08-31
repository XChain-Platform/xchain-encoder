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
 * XChain Encoder - process crash visibility
 *
 * The encoder has neither an uncaughtException nor an unhandledRejection
 * handler, so a throw outside a request chain kills the process with node's
 * default stderr dump: no timestamp, no level, no service tag, nothing a
 * collector can key on. What an operator sees is a container that restarted.
 *
 * These handlers emit one structured CRASH record instead. Emission is through
 * the shim's getLogger() rather than console because a patched console line
 * cannot carry structured fields, and the fields are the point.
 *
 * They are installed from the entry-point guard in api.js, never at module
 * scope: several suites require api.js in-process under mocha, which installs
 * its own handlers, and a module-scope handler that exits would abort the whole
 * run instead of failing one test.
 *
 ********************************************************************/

'use strict'

const { getLogger, getRegistry } = require('./observability')

let _counters = null

function counters() {
  if (!_counters) {
    const registry = getRegistry()
    _counters = {
      crashes: registry.counter({
        name: 'xchain_crashes_total',
        help: 'Uncaught exceptions and unhandled rejections',
        labelNames: ['kind']
      })
    }
  }
  return _counters
}

/**
 * @param {object} [opts]
 * @param {object} [opts.proc]               process-like target, for tests
 * @param {boolean} [opts.exitOnUncaught=true]
 */
function installCrashHandlers({ proc = process, exitOnUncaught = true } = {}) {
  const emit = (kind, err) => {
    try { counters().crashes.inc({ kind }, 1) } catch { /* never mask the crash */ }
    try {
      getLogger().error('CRASH', {
        kind,
        err: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : undefined
      })
    } catch { /* never mask the crash */ }
  }

  proc.on('uncaughtException', (err) => {
    emit('uncaughtException', err)
    // Process state after an uncaught throw is unknown, and the encoder holds
    // in-process outpoint reservations that guard against double-spends, so it
    // exits for a supervised restart rather than serving from a half-applied
    // reservation table.
    if (exitOnUncaught) proc.exit(1)
  })

  proc.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    emit('unhandledRejection', err)
  })
}

// Tests only: the counter handles are process-wide.
function _resetCrashCounters() {
  _counters = null
}

module.exports = { installCrashHandlers, _resetCrashCounters }
