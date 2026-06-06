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

const { PerformanceObserver, monitorEventLoopDelay } = require('perf_hooks')
const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Histogram — nanosecond-precision latency recorder
// ---------------------------------------------------------------------------

class Histogram {
  constructor (label) {
    this.label = label
    this._samples = new Float64Array(1024)
    this._count = 0
    this._sorted = false
  }

  record (ns) {
    if (this._count >= this._samples.length) {
      const next = new Float64Array(this._samples.length * 2)
      next.set(this._samples)
      this._samples = next
    }
    this._samples[this._count++] = ns
    this._sorted = false
  }

  get count () { return this._count }

  get min () {
    this._ensureSorted()
    return this._count > 0 ? this._samples[0] : 0
  }

  get max () {
    this._ensureSorted()
    return this._count > 0 ? this._samples[this._count - 1] : 0
  }

  get mean () {
    if (this._count === 0) return 0
    let sum = 0
    for (let i = 0; i < this._count; i++) sum += this._samples[i]
    return sum / this._count
  }

  percentile (p) {
    if (this._count === 0) return 0
    this._ensureSorted()
    const idx = Math.min(Math.ceil((p / 100) * this._count) - 1, this._count - 1)
    return this._samples[Math.max(idx, 0)]
  }

  reset () {
    this._count = 0
    this._sorted = false
  }

  toJSON () {
    const toMs = ns => +(ns / 1e6).toFixed(4)
    return {
      label: this.label,
      count: this._count,
      min_ms: toMs(this.min),
      max_ms: toMs(this.max),
      mean_ms: toMs(this.mean),
      p50_ms: toMs(this.percentile(50)),
      p95_ms: toMs(this.percentile(95)),
      p99_ms: toMs(this.percentile(99))
    }
  }

  _ensureSorted () {
    if (this._sorted) return
    const view = this._samples.subarray(0, this._count)
    view.sort()
    this._sorted = true
  }
}

// ---------------------------------------------------------------------------
// MemoryTracker — periodic heap snapshots
// ---------------------------------------------------------------------------

class MemoryTracker {
  constructor (label, intervalMs = 1000) {
    this.label = label
    this._intervalMs = intervalMs
    this._timer = null
    this._snapshots = []
  }

  start () {
    this.snapshot()
    this._timer = setInterval(() => this.snapshot(), this._intervalMs)
    this._timer.unref()
  }

  stop () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this.snapshot()
  }

  snapshot () {
    const mem = process.memoryUsage()
    this._snapshots.push({
      ts: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external
    })
  }

  get snapshots () { return this._snapshots }

  growthRate () {
    if (this._snapshots.length < 2) return 0
    const first = this._snapshots[0]
    const last = this._snapshots[this._snapshots.length - 1]
    const secs = (last.ts - first.ts) / 1000
    return secs > 0 ? (last.heapUsed - first.heapUsed) / secs : 0
  }

  toJSON () {
    const first = this._snapshots[0] || {}
    const last = this._snapshots[this._snapshots.length - 1] || {}
    return {
      label: this.label,
      samples: this._snapshots.length,
      heapUsed_start_mb: +((first.heapUsed || 0) / 1e6).toFixed(2),
      heapUsed_end_mb: +((last.heapUsed || 0) / 1e6).toFixed(2),
      rss_end_mb: +((last.rss || 0) / 1e6).toFixed(2),
      growthRate_bytes_sec: +this.growthRate().toFixed(0)
    }
  }
}

// ---------------------------------------------------------------------------
// GcTracker — GC pause observer
// ---------------------------------------------------------------------------

class GcTracker {
  constructor () {
    this._pauses = []
    this._observer = null
  }

  start () {
    this._observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        this._pauses.push({ kind: entry.detail ? entry.detail.kind : entry.kind, duration: entry.duration, startTime: entry.startTime })
      }
    })
    this._observer.observe({ entryTypes: ['gc'] })
  }

  stop () {
    if (this._observer) { this._observer.disconnect(); this._observer = null }
  }

  get pauses () { return this._pauses }
  get pauseCount () { return this._pauses.length }

  get totalPauseMs () {
    let sum = 0
    for (const p of this._pauses) sum += p.duration
    return sum
  }

  get maxPauseMs () {
    let max = 0
    for (const p of this._pauses) { if (p.duration > max) max = p.duration }
    return max
  }

  toJSON () {
    return {
      pauseCount: this.pauseCount,
      totalPause_ms: +this.totalPauseMs.toFixed(2),
      maxPause_ms: +this.maxPauseMs.toFixed(2)
    }
  }
}

// ---------------------------------------------------------------------------
// EldTracker — Event Loop Delay histogram
// ---------------------------------------------------------------------------

class EldTracker {
  constructor (resolutionMs = 10) {
    this._histogram = monitorEventLoopDelay({ resolution: resolutionMs })
  }

  start () { this._histogram.enable() }
  stop () { this._histogram.disable() }
  reset () { this._histogram.reset() }

  toJSON () {
    const h = this._histogram
    return {
      mean_ms: +(h.mean / 1e6).toFixed(4),
      min_ms: +(h.min / 1e6).toFixed(4),
      max_ms: +(h.max / 1e6).toFixed(4),
      p50_ms: +(h.percentile(50) / 1e6).toFixed(4),
      p99_ms: +(h.percentile(99) / 1e6).toFixed(4)
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatReport (results) {
  const header = ['ID', 'Label', 'Ops', 'ops/sec', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'max (ms)', 'heap +/- (MB)']
  const rows = results.map(r => {
    const h = r.histogram
    const opsPerSec = h.count > 0 && h.mean_ms > 0 ? (1000 / h.mean_ms).toFixed(0) : 'N/A'
    const heapDelta = r.memory ? (r.memory.heapUsed_end_mb - r.memory.heapUsed_start_mb).toFixed(2) : 'N/A'
    return [
      r.id,
      r.label.substring(0, 28),
      String(h.count),
      opsPerSec,
      h.p50_ms.toFixed(3),
      h.p95_ms.toFixed(3),
      h.p99_ms.toFixed(3),
      h.max_ms.toFixed(3),
      heapDelta
    ]
  })

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length))
  const line = cols => cols.map((c, i) => pad(c, widths[i])).join('  ')

  const lines = [
    '',
    line(header),
    widths.map(w => '-'.repeat(w)).join('  '),
    ...rows.map(r => line(r)),
    ''
  ]
  return lines.join('\n')
}

function writeJsonReport (results, filepath) {
  const dir = path.dirname(filepath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const report = {
    run_id: new Date().toISOString(),
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    scenarios: {}
  }
  for (const r of results) {
    report.scenarios[r.id] = {
      label: r.label,
      histogram: r.histogram,
      memory: r.memory || null,
      gc: r.gc || null
    }
  }
  fs.writeFileSync(filepath, JSON.stringify(report, null, 2))
  return filepath
}

module.exports = {
  Histogram,
  MemoryTracker,
  GcTracker,
  EldTracker,
  formatReport,
  writeJsonReport
}
