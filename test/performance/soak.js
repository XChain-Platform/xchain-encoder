#!/usr/bin/env node
'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const path = require('path')
const { BASE, CPLX, UTXO_COUNTS, PAYLOAD_SIZES, makeEncoder } = require('./helpers/fixtures')
const { Histogram, MemoryTracker, GcTracker, EldTracker, formatReport, writeJsonReport } = require('./helpers/metrics')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const param = (name, fallback) => {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback
}

const DURATION_SECS = parseInt(param('--duration', '60'), 10)
const SCENARIO_ID = param('--scenario', 'BASE-01')
const REPORT = flag('--report')

const WINDOW_SECS = 10
const LEAK_THRESHOLD_MB = 50

// ---------------------------------------------------------------------------
// Soak runner
// ---------------------------------------------------------------------------

async function soak () {
  const all = [...BASE, ...CPLX, ...UTXO_COUNTS, ...PAYLOAD_SIZES]
  const scenario = all.find(s => s.id === SCENARIO_ID)
  if (!scenario) {
    console.error(`Unknown scenario: ${SCENARIO_ID}`)
    console.error('Available:', all.map(s => s.id).join(', '))
    process.exit(1)
  }

  const encoder = makeEncoder(scenario.network)

  console.log(`\nxchain-encoder soak test`)
  console.log(`  Scenario:  ${scenario.id} — ${scenario.label}`)
  console.log(`  Duration:  ${DURATION_SECS}s`)
  console.log(`  Window:    ${WINDOW_SECS}s\n`)

  // Global trackers
  const globalHist = new Histogram('global')
  const mem = new MemoryTracker('soak', 1000)
  const gc = new GcTracker()
  const eld = new EldTracker(10)

  gc.start()
  mem.start()
  eld.start()

  const deadline = Date.now() + DURATION_SECS * 1000
  let windowStart = Date.now()
  let windowOps = 0
  let windowHist = new Histogram('window')
  let windowNum = 0
  let baselineP99 = null
  let baselineHeap = null

  while (Date.now() < deadline) {
    const utxos = scenario.makeUtxos()
    const t0 = process.hrtime.bigint()
    await encoder.createTransaction(
      utxos, scenario.pubkey, scenario.customOutputs,
      scenario.data, scenario.rawData, scenario.fee, scenario.rbf,
      scenario.encoding, scenario.change,
      scenario.p2shHash, scenario.p2shHex, scenario.compressedPubKey,
      scenario.unconfirmed, scenario.feePerKb, scenario.dust
    )
    const elapsed = Number(process.hrtime.bigint() - t0)
    globalHist.record(elapsed)
    windowHist.record(elapsed)
    windowOps++

    // Window boundary
    if (Date.now() - windowStart >= WINDOW_SECS * 1000) {
      windowNum++
      const elapsed_s = (Date.now() - windowStart) / 1000
      const opsPerSec = (windowOps / elapsed_s).toFixed(0)
      const wp99 = windowHist.percentile(99) / 1e6
      const currentHeap = process.memoryUsage().heapUsed / 1e6

      // Set baselines from first completed window
      if (baselineP99 === null) {
        baselineP99 = wp99
        baselineHeap = currentHeap
      }

      const t = windowNum * WINDOW_SECS
      process.stdout.write(
        `  [t=${t}s]  ops: ${windowOps}  ops/sec: ${opsPerSec}` +
        `  p50: ${(windowHist.percentile(50) / 1e6).toFixed(3)}ms` +
        `  p99: ${wp99.toFixed(3)}ms` +
        `  heap: ${currentHeap.toFixed(1)}MB` +
        `  ELD: ${(eld.toJSON().max_ms).toFixed(2)}ms`
      )

      // Warnings
      const warnings = []
      if (currentHeap - baselineHeap > LEAK_THRESHOLD_MB) {
        warnings.push(`WARN: heap grew +${(currentHeap - baselineHeap).toFixed(1)}MB from baseline`)
      }
      if (baselineP99 > 0 && wp99 > baselineP99 * 2) {
        warnings.push(`WARN: p99 drift ${(wp99 / baselineP99).toFixed(1)}x baseline`)
      }

      if (warnings.length > 0) {
        console.log('  ' + warnings.join(' | '))
      } else {
        console.log('')
      }

      // Reset window
      windowHist.reset()
      windowOps = 0
      windowStart = Date.now()
      eld.reset()
    }
  }

  mem.stop()
  gc.stop()
  eld.stop()

  // Final summary
  const gj = globalHist.toJSON()
  const mj = mem.toJSON()
  const gcj = gc.toJSON()

  console.log('\n--- Soak Test Summary ---')
  console.log(`  Total ops:        ${gj.count}`)
  console.log(`  Throughput:       ${gj.mean_ms > 0 ? (1000 / gj.mean_ms).toFixed(0) : 'N/A'} ops/sec`)
  console.log(`  Latency p50:      ${gj.p50_ms.toFixed(3)} ms`)
  console.log(`  Latency p95:      ${gj.p95_ms.toFixed(3)} ms`)
  console.log(`  Latency p99:      ${gj.p99_ms.toFixed(3)} ms`)
  console.log(`  Latency max:      ${gj.max_ms.toFixed(3)} ms`)
  console.log(`  Heap start:       ${mj.heapUsed_start_mb} MB`)
  console.log(`  Heap end:         ${mj.heapUsed_end_mb} MB`)
  console.log(`  Heap growth:      ${mj.growthRate_bytes_sec} bytes/sec`)
  console.log(`  GC pauses:        ${gcj.pauseCount} (total ${gcj.totalPause_ms.toFixed(1)}ms, max ${gcj.maxPause_ms.toFixed(1)}ms)`)
  console.log('')

  if (REPORT) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = path.join(__dirname, '..', '..', 'reports', `soak-${ts}.json`)
    writeJsonReport([{
      id: scenario.id,
      label: scenario.label,
      histogram: gj,
      memory: mj,
      gc: gcj
    }], outPath)
    console.log(`Report written to: ${outPath}`)
  }
}

soak().catch(err => {
  console.error(err)
  process.exit(1)
})
