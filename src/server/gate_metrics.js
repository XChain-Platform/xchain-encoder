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
 * Concurrency-gate metrics
 *
 * Mirrors each gate's shed count, live occupancy and cap into the metrics
 * registry at scrape time. The shared http_requests_in_flight gauge follows the
 * socket (it drops when a caller hangs up), while a gate slot follows the work
 * (see requestGate.hold in api.js), so under a hang-up stampede only the gate
 * series show the real load. The gate series also separate a gate shed from a
 * per-IP limiter 429, which both land in http_requests_total as 429.
 *
 ********************************************************************/

'use strict'

/**
 * @param {?{registry: ?object}} observability  installObservability() handle; its registry is
 *        always built, and only the /metrics route is gated by METRICS_ENABLED.
 * @param {?Object<string, {getStats: function}>} gates  gates keyed by the `gate` label value.
 * @returns {boolean} true when the series were registered.
 */
function installGateMetrics(observability, gates) {
  const registry = observability && observability.registry
  if (!registry) return false
  const entries = Object.entries(gates || {})
    .filter(([, gate]) => gate && typeof gate.getStats === 'function')
  if (entries.length === 0) return false

  // setMonotonic, not inc: shed is a lifetime count the gate already keeps, so
  // a re-read must not double-count what the last scrape saw.
  const shed = registry.counter({
    name: 'xchain_encoder_gate_shed_total',
    help: 'Requests refused with 429 by the concurrency gate since process start',
    labelNames: ['gate']
  })
  const inFlight = registry.gauge({
    name: 'xchain_encoder_gate_in_flight',
    help: 'Requests currently holding a slot under the gate',
    labelNames: ['gate']
  })
  const limit = registry.gauge({
    name: 'xchain_encoder_gate_limit',
    help: 'Concurrent-request cap of the gate; 0 means the gate is disabled',
    labelNames: ['gate']
  })

  registry.addCollector(() => {
    for (const [name, gate] of entries) {
      const stats = gate.getStats()
      const labels = { gate: name }
      shed.setMonotonic(labels, stats.shed)
      if (Number.isFinite(stats.in_flight)) inFlight.set(labels, stats.in_flight)
      if (Number.isFinite(stats.limit)) limit.set(labels, stats.limit)
    }
  })
  return true
}

module.exports = { installGateMetrics }
