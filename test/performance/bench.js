#!/usr/bin/env node
'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const path = require('path')
const { BASE, CPLX, UTXO_COUNTS, PAYLOAD_SIZES, makeEncoder } = require('./helpers/fixtures')
const { Histogram, MemoryTracker, GcTracker, formatReport, writeJsonReport } = require('./helpers/metrics')

// ---------------------------------------------------------------------------
// CLI argument parsing (no deps)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const param = (name, fallback) => {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback
}

const FULL = flag('--full')
const JSON_OUT = flag('--json')
const SINGLE = param('--scenario', null)
const WARMUP = parseInt(param('--warmup', '100'), 10)
const ITERS = parseInt(param('--iters', '1000'), 10)

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function runScenario (scenario, iters, warmupIters) {
  const encoder = makeEncoder(scenario.network)

  // Warmup — JIT compilation, discard results
  for (let i = 0; i < warmupIters; i++) {
    const utxos = scenario.makeUtxos()
    await encoder.createTransaction(
      utxos, scenario.pubkey, scenario.customOutputs,
      scenario.data, scenario.rawData, scenario.fee, scenario.rbf,
      scenario.encoding, scenario.change,
      scenario.p2shHash, scenario.p2shHex, scenario.compressedPubKey,
      scenario.unconfirmed, scenario.feePerKb, scenario.dust
    )
  }

  // Measurement
  const histogram = new Histogram(scenario.id)
  const mem = new MemoryTracker(scenario.id)
  const gc = new GcTracker()

  gc.start()
  mem.start()

  for (let i = 0; i < iters; i++) {
    const utxos = scenario.makeUtxos()
    const t0 = process.hrtime.bigint()
    await encoder.createTransaction(
      utxos, scenario.pubkey, scenario.customOutputs,
      scenario.data, scenario.rawData, scenario.fee, scenario.rbf,
      scenario.encoding, scenario.change,
      scenario.p2shHash, scenario.p2shHex, scenario.compressedPubKey,
      scenario.unconfirmed, scenario.feePerKb, scenario.dust
    )
    histogram.record(Number(process.hrtime.bigint() - t0))
  }

  mem.stop()
  gc.stop()

  return {
    id: scenario.id,
    label: scenario.label,
    histogram: histogram.toJSON(),
    memory: mem.toJSON(),
    gc: gc.toJSON()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  // Select scenarios
  let scenarios
  if (SINGLE) {
    const all = [...BASE, ...CPLX, ...UTXO_COUNTS, ...PAYLOAD_SIZES]
    const match = all.find(s => s.id === SINGLE)
    if (!match) {
      console.error(`Unknown scenario: ${SINGLE}`)
      console.error('Available:', all.map(s => s.id).join(', '))
      process.exit(1)
    }
    scenarios = [match]
  } else if (FULL) {
    scenarios = [...BASE, ...CPLX, ...UTXO_COUNTS, ...PAYLOAD_SIZES]
  } else {
    scenarios = BASE
  }

  console.log(`\nxchain-encoder benchmark  |  ${scenarios.length} scenarios  |  ${WARMUP} warmup  |  ${ITERS} iterations\n`)

  const results = []
  for (const s of scenarios) {
    process.stdout.write(`  ${s.id}: ${s.label} ... `)
    const result = await runScenario(s, ITERS, WARMUP)
    const opsPerSec = result.histogram.mean_ms > 0 ? (1000 / result.histogram.mean_ms).toFixed(0) : 'N/A'
    console.log(`${opsPerSec} ops/sec  p99=${result.histogram.p99_ms.toFixed(3)}ms`)
    results.push(result)
  }

  console.log(formatReport(results))

  if (JSON_OUT) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = path.join(__dirname, '..', '..', 'reports', `bench-${ts}.json`)
    writeJsonReport(results, outPath)
    console.log(`JSON report written to: ${outPath}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
