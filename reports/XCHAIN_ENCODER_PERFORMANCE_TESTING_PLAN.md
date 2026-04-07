# XChain Encoder: Performance & Load Testing Plan

## 1. Executive Summary

The `xchain-encoder` builds PSBTs by encoding structured ACTION data into blockchain transactions. Its performance directly affects transaction broadcasting latency and overall platform throughput. This plan targets the encoder's critical hot paths: data preparation/chunking, AES-128-CTR obfuscation, PSBT construction via `bitcoinjs-lib`, UTXO selection, and the per-input RPC calls for non-SegWit UTXOs.

The encoder exposes two interfaces: a JSON-RPC API server (`src/api.js`) and a direct library call (`XChainEncoder.createTransaction()`). Both share the same core logic, but the API layer adds Express middleware overhead (Helmet, rate limiting, JSON-RPC routing, validation).

---

## 2. Architecture & Hot-Path Analysis

### 2.1 Critical Processing Steps (in execution order)

| Step | Source Location | Operation | Performance Profile |
|------|----------------|-----------|-------------------|
| 1. Parameter validation | `validator.js` | Type/range checks on 15 parameters | CPU-bound, O(n) for UTXO array (max 500) |
| 2. Fee rate fetch | `BlockchainConnector.getFeePerKilobyte()` | Single RPC call to `estimatesmartfee` | Network I/O, 1 round-trip per tx |
| 3. UTXO fetch (optional) | `UtxoTracker.getUtxosFromAddress()` | HTTP POST to external tracker service | Network I/O, 1 round-trip per tx |
| 4. UTXO deduplication | `XChainEncoder.js:252-273` | Nested loop removing duplicates | CPU-bound, **O(n^2)** where n = UTXO count |
| 5. UTXO sorting | `XChainEncoder.js:275` | Sort by value descending (largest-first) | CPU-bound, O(n log n) |
| 6. Data preparation | `prepareData()` lines 70-172 | Chunk data by encoding type, build redeem scripts | CPU-bound + crypto (P2SH/P2WSH script compilation) |
| 7. Obfuscation | `obfuscate()` lines 174-182 | AES-128-CTR encryption per chunk | CPU-bound, O(data_length) per chunk |
| 8. Output generation | `createTransaction()` lines 292-455 | Build PSBT outputs per encoding type | CPU-bound, `bitcoinjs-lib` PSBT manipulation |
| 9. Input selection | `createTransaction()` lines 486-537 | Iterate UTXOs, fetch raw tx for non-SegWit | **Network I/O: N RPC calls** for N non-SegWit inputs |
| 10. Fee estimation | `TxSizeEstimator` (static methods) | Calculate vSize by script type | CPU-bound, O(inputs + outputs) |
| 11. Change calculation | `createTransaction()` lines 544-559 | Compute change, add output | CPU-bound, trivial |
| 12. PSBT serialization | `psbt.toHex()` (in api.js:124) | Serialize PSBT to hex string | CPU-bound, proportional to tx size |

### 2.2 Identified Bottlenecks

| Bottleneck | Severity | Description |
|-----------|----------|-------------|
| **Per-input `getrawtransaction` RPC** | **HIGH** | Each non-SegWit UTXO triggers a synchronous HTTP round-trip to the coin daemon. With 50+ legacy inputs, this dominates latency. |
| **UTXO deduplication O(n^2)** | **MEDIUM** | Nested loop at lines 252-273. Acceptable for typical counts (<100) but degrades at the 500-UTXO validator limit. |
| **AES-128-CTR on large payloads** | **LOW** | Obfuscation is O(data_length) but Node.js `crypto` is C-backed and fast. Only relevant at max payload (65,536 bytes). |
| **`bitcoinjs-lib` PSBT construction** | **MEDIUM** | Library overhead for adding inputs/outputs, especially P2SH/P2WSH redeem scripts. Not parallelizable within a single PSBT. |
| **Express middleware stack** | **LOW** | Helmet, rate limiter, JSON-RPC router add per-request overhead. Negligible for individual requests but measurable under high concurrency. |
| **Single-threaded Node.js** | **MEDIUM** | All encoding is synchronous on the event loop. Concurrent API requests queue behind CPU-bound PSBT construction. |

---

## 3. Test Scenarios

### 3.1 Baseline Performance (Single-Request Latency)

**Purpose:** Establish latency baselines for each encoding type under zero contention.

| Scenario ID | Description | Parameters | Expected Metric |
|------------|-------------|------------|-----------------|
| `BASE-01` | OP_RETURN, minimal payload | 20-byte SEND action, 1 SegWit UTXO | Sub-10ms encoding time |
| `BASE-02` | OP_RETURN, max payload | 76-byte payload, 1 SegWit UTXO | Sub-15ms encoding time |
| `BASE-03` | P2SH, single chunk | 400-byte payload, 3 SegWit UTXOs | Sub-25ms encoding time |
| `BASE-04` | P2WSH, single chunk | 3,500-byte payload, 5 SegWit UTXOs | Sub-30ms encoding time |
| `BASE-05` | MULTISIGN, single chunk | 55-byte payload, 2 SegWit UTXOs | Sub-15ms encoding time |
| `BASE-06` | P2SH, multi-chunk | 2,000-byte payload (5 chunks), 10 UTXOs | Sub-50ms encoding time |
| `BASE-07` | P2WSH, max payload | 65,536-byte payload, 50 UTXOs | Measure and record baseline |
| `BASE-08` | OP_RETURN with legacy UTXOs | 50-byte payload, 5 non-SegWit UTXOs | Baseline including RPC round-trips |

**Methodology:** Run each scenario 1,000 times with mocked RPC dependencies (instant responses). Record p50, p95, p99 latencies and standard deviation.

### 3.2 Sustained High Throughput

**Purpose:** Detect memory leaks, GC pressure, and performance degradation over time.

| Scenario ID | Description | Duration | Rate | Key Observation |
|------------|-------------|----------|------|-----------------|
| `SUST-01` | Constant OP_RETURN stream | 10 minutes | 100 req/sec | Memory growth, GC pauses, latency drift |
| `SUST-02` | Mixed encoding types | 30 minutes | 50 req/sec | Weighted: 60% OP_RETURN, 25% P2SH, 10% MULTISIGN, 5% P2WSH |
| `SUST-03` | Heavy P2WSH stream | 10 minutes | 20 req/sec | Large payload memory allocation patterns |
| `SUST-04` | Maximum UTXO count | 15 minutes | 30 req/sec | 500 UTXOs per request, stress dedup loop |

**Pass Criteria:**
- Memory usage remains within 2x of initial heap after 10 minutes
- p99 latency does not increase by more than 50% from minute 1 to minute 10
- Zero unhandled errors or crashes
- No PSBT validation failures

### 3.3 Spike Load Testing

**Purpose:** Verify the encoder handles sudden traffic surges without crashing or producing invalid output.

| Scenario ID | Description | Profile | Key Observation |
|------------|-------------|---------|-----------------|
| `SPIKE-01` | Idle to burst | 0 req/sec for 30s, then 200 req/sec for 60s, then 0 | Recovery time, error rate during spike |
| `SPIKE-02` | Repeated spikes | Alternating 10 req/sec (30s) and 150 req/sec (30s) for 5 minutes | Latency stability across transitions |
| `SPIKE-03` | Gradual ramp | 10 req/sec ramping to 500 req/sec over 5 minutes | Find the throughput ceiling |
| `SPIKE-04` | Spike with rate limiter | Same as SPIKE-01, but with `RATE_LIMIT_RPM=120` | Verify rate limiter rejects gracefully (HTTP 429) without affecting valid requests |

**Pass Criteria:**
- No process crashes or unhandled promise rejections
- Error rate returns to 0% within 10 seconds after spike subsides
- All successful responses contain valid PSBT hex
- Rate limiter returns proper JSON-RPC error codes (not generic 500s)

### 3.4 Complex Payload Stress

**Purpose:** Test performance at the boundaries of allowed input complexity.

| Scenario ID | Description | Parameters |
|------------|-------------|------------|
| `CPLX-01` | Maximum data payload | 65,536 bytes with P2WSH encoding |
| `CPLX-02` | Maximum custom outputs | 100 custom outputs + data encoding |
| `CPLX-03` | Maximum UTXO count | 500 UTXOs, mixed SegWit/legacy |
| `CPLX-04` | Combined maximum | 65,536 bytes + 100 custom outputs + 500 UTXOs |
| `CPLX-05` | P2SH two-tx pattern | 2,000-byte payload requiring multi-chunk P2SH + spending tx construction |
| `CPLX-06` | All ACTION types | Cycle through SEND, ISSUE, MINT, DESTROY, ORDER, DISPENSER, DIVIDEND, etc. |

**Metrics Focus:**
- Absolute latency for each scenario
- Memory high-water mark during PSBT construction
- `bitcoinjs-lib` PSBT serialization time for large transactions

### 3.5 Concurrent Encoding Requests

**Purpose:** Since Node.js is single-threaded, test how concurrent API requests affect each other's latency.

| Scenario ID | Description | Concurrency | Payload |
|------------|-------------|-------------|---------|
| `CONC-01` | Light concurrent load | 10 simultaneous requests | OP_RETURN, minimal |
| `CONC-02` | Moderate concurrent load | 50 simultaneous requests | Mixed encoding types |
| `CONC-03` | Heavy concurrent load | 100 simultaneous requests | P2SH with 50 UTXOs each |
| `CONC-04` | Sustained concurrency | 20 concurrent, 60-second duration | Mixed payloads |
| `CONC-05` | Concurrency + large payloads | 10 simultaneous P2WSH max-payload requests | 65,536 bytes each |

**Key Observations:**
- Event loop lag (time between scheduling and execution)
- Request queuing behavior under CPU saturation
- Whether any requests time out or get dropped
- Memory footprint with N simultaneous PSBT objects in memory

### 3.6 Dependency Latency Impact

**Purpose:** Measure how slow upstream dependencies affect encoder throughput.

| Scenario ID | Simulated Condition | Expected Impact |
|------------|--------------------|-----------------| 
| `DEP-01` | `estimatesmartfee` RPC responds in 500ms (vs. typical <50ms) | Latency increase proportional to delay; throughput halved |
| `DEP-02` | `getrawtransaction` RPC responds in 200ms per call | Severe latency increase for non-SegWit inputs (200ms * N inputs) |
| `DEP-03` | UTXO tracker responds in 1 second | Only affects requests without pre-supplied UTXOs |
| `DEP-04` | RPC intermittent failures (10% error rate) | Measure retry behavior, error propagation, partial PSBT cleanup |
| `DEP-05` | RPC connection timeout (30s) | Verify encoder doesn't hold resources indefinitely |

---

## 4. Tooling & Instrumentation

### 4.1 Recommended Tools

| Tool | Purpose | Rationale |
|------|---------|-----------|
| **k6** (Grafana) | HTTP load generation against the JSON-RPC API | Native JavaScript scripting, excellent metrics collection, supports ramp/spike/soak profiles. Ideal for scenarios SUST-*, SPIKE-*, CONC-*. |
| **Custom Node.js harness** | Direct `XChainEncoder.createTransaction()` benchmarking | Bypasses Express overhead to isolate core encoding performance. Uses `perf_hooks.performance.now()` for sub-millisecond timing. Essential for BASE-* and CPLX-* scenarios. |
| **Clinic.js** (Doctor + Flame) | CPU profiling and event loop analysis | Identifies hot functions, GC pressure, and event loop blocking. Run during SUST-* scenarios to find optimization targets. |
| **0x** | Flamegraph generation | Lightweight alternative to Clinic.js for quick CPU profiling of specific encoding paths. |
| **`process.memoryUsage()`** | Heap tracking | Poll at regular intervals during sustained tests to detect memory leaks. Track `heapUsed`, `heapTotal`, `external`, `arrayBuffers`. |
| **`perf_hooks.monitorEventLoopDelay()`** | Event loop lag | Node.js built-in histogram for event loop delay. Critical for detecting CPU saturation under concurrent load. |

### 4.2 Mock Strategy

Performance tests should isolate the encoder from network I/O variability:

- **Mock `BlockchainConnector`**: Return pre-computed fee rates and raw transaction hex instantly. Use configurable delays for DEP-* scenarios.
- **Mock `UtxoTracker`**: Return pre-built UTXO sets instantly. Or supply UTXOs directly via the `utxos` parameter to bypass the tracker entirely.
- **Pre-generate test data**: Build a library of ACTION payloads (via the existing `actionFactory.js` test helper) and UTXO sets (via `utxoFactory.js`) covering all encoding types and sizes.

For API-level tests (k6), run the encoder server with mocked dependencies behind the scenes.

### 4.3 Key Metrics

| Metric | Unit | Collection Method | Target |
|--------|------|-------------------|--------|
| **Encoding throughput** | tx/sec | k6 `http_reqs` counter | >100 OP_RETURN tx/sec, >50 P2SH tx/sec |
| **End-to-end latency** | ms | k6 `http_req_duration` or custom harness `performance.now()` | p50 <20ms, p99 <100ms (OP_RETURN, mocked deps) |
| **PSBT construction time** | ms | Custom harness, wrapping `createTransaction()` | Isolate from I/O to measure pure computation |
| **Data preparation time** | ms | Instrument `prepareData()` entry/exit | Track chunking + script compilation overhead |
| **Obfuscation time** | ms | Instrument `obfuscate()` calls | Should be <1ms for payloads under 10KB |
| **UTXO dedup time** | ms | Instrument dedup loop | Track scaling behavior at 100, 250, 500 UTXOs |
| **Input selection time** | ms | Instrument lines 486-537 | Dominated by `getrawtransaction` calls for legacy UTXOs |
| **Error rate** | % | k6 `http_req_failed` + custom error counters | <0.1% under normal load, <5% under spike |
| **Heap memory** | MB | `process.memoryUsage().heapUsed` polled every 1s | No monotonic growth over 10-minute window |
| **Event loop delay** | ms | `monitorEventLoopDelay()` histogram | p99 <50ms under sustained load |
| **GC pause duration** | ms | `--expose-gc` + `gc` event hooks | No individual pause >100ms |
| **RSS (Resident Set Size)** | MB | `process.memoryUsage().rss` | Stable within 2x baseline after warmup |

---

## 5. Prioritized Roadmap

### Phase 1: Baseline & Core Benchmarks (Week 1)

**Priority: Critical** -- Establishes the performance floor everything else is measured against.

1. Build the custom Node.js benchmark harness
   - Direct `createTransaction()` calls with pre-supplied UTXOs and mocked RPC
   - Instrument with `perf_hooks` for sub-ms timing
   - Use existing `utxoFactory.js` and `actionFactory.js` for test data
2. Run `BASE-01` through `BASE-08` -- single-request latency for all encoding types
3. Run `CPLX-01` through `CPLX-06` -- complex payload stress tests
4. Generate flamegraphs with `0x` for the slowest scenarios
5. Document baseline numbers as the performance contract

**Deliverable:** Baseline latency table and flamegraphs for each encoding type.

### Phase 2: Sustained Load & Memory (Week 2)

**Priority: High** -- Memory leaks and GC issues only surface under sustained operation.

1. Set up k6 test scripts targeting the JSON-RPC API
2. Run `SUST-01` through `SUST-04` with memory monitoring
3. Run Clinic.js Doctor during `SUST-02` (mixed workload) to detect event loop issues
4. Analyze heap snapshots if memory growth detected
5. Run `CONC-01` through `CONC-05` to characterize concurrent behavior

**Deliverable:** Memory profile report, event loop analysis, concurrency scaling chart.

### Phase 3: Spike & Resilience (Week 3)

**Priority: High** -- Production traffic is bursty; the encoder must not crash.

1. Implement k6 spike profiles for `SPIKE-01` through `SPIKE-04`
2. Run `DEP-01` through `DEP-05` with configurable mock latencies
3. Verify rate limiter behavior under `SPIKE-04`
4. Test error handling under `DEP-04` (intermittent failures)

**Deliverable:** Spike response analysis, throughput ceiling identification, dependency sensitivity report.

### Phase 4: Optimization & Regression Suite (Week 4)

**Priority: Medium** -- Turn findings into actionable improvements and ongoing protection.

1. Address identified bottlenecks:
   - UTXO dedup: Replace O(n^2) loop with Set-based dedup
   - Non-SegWit input fetching: Batch `getrawtransaction` calls if coin daemon supports `getblock` with verbosity=2
   - Consider `worker_threads` for CPU-bound PSBT construction under high concurrency
2. Build a regression benchmark suite (subset of BASE-* and CPLX-*) that runs in CI
3. Set performance budgets with automated pass/fail thresholds
4. Document all findings and optimization recommendations

**Deliverable:** Optimization PR(s), CI benchmark suite, performance budget configuration.

---

## 6. Integration Strategy

### 6.1 Local Development

- **Quick benchmark:** `npm run bench` -- runs BASE-01 through BASE-05 (< 30 seconds). Developers run this before committing changes to encoding logic.  
- **Full benchmark:** `npm run bench:full` -- runs all BASE-* and CPLX-* scenarios (< 5 minutes).  
- **Profiling:** `npm run profile` -- runs SUST-02 with Clinic.js Doctor attached, outputs HTML report.

### 6.2 CI Pipeline Integration

| Stage | Tests | Trigger | Failure Threshold |
|-------|-------|---------|-------------------|
| **PR check** | BASE-01, BASE-03, BASE-05 (one per encoding type) | Every PR touching `src/` | p99 latency > 2x baseline |
| **Nightly** | All BASE-*, CPLX-*, SUST-01 (shortened to 2 min) | Scheduled 2 AM | p99 > 1.5x baseline OR memory growth > 50% |
| **Weekly** | Full suite including SPIKE-* and DEP-* | Scheduled Sunday | Manual review of results |

**Implementation Notes:**
- CI benchmarks require consistent hardware. Use dedicated runners or bare-metal instances (not shared CI runners with variable CPU allocation).
- Mock all external dependencies in CI. Real coin daemons introduce network variability.
- Store results as JSON artifacts; compare against the checked-in baseline file.
- Use a simple threshold-based gate: if any metric exceeds its budget by the configured percentage, fail the pipeline.

### 6.3 Staging Environment

- Run full k6 load tests against a staging deployment with real (regtest) coin daemon
- Measure true end-to-end latency including network hops
- Use `xchain-regtest-miner` for realistic block production during tests
- Schedule after each release candidate

---

## 7. Reporting & Visualization

### 7.1 Report Format

Each performance test run produces a JSON results file:

```json
{
  "run_id": "2026-04-03T12:00:00Z",
  "git_sha": "abc1234",
  "node_version": "v20.x.x",
  "scenarios": {
    "BASE-01": {
      "iterations": 1000,
      "latency_ms": { "p50": 8.2, "p95": 12.1, "p99": 15.3, "max": 22.0 },
      "throughput_per_sec": 122.5,
      "errors": 0,
      "memory_peak_mb": 45.2
    }
  }
}
```

### 7.2 Tracking & Visualization

- **Trend dashboard:** Plot p50/p95/p99 latency per scenario over time (by git SHA). Use Grafana if available, otherwise a simple HTML chart generated from JSON results.  
- **Regression detection:** Compare each CI run against the rolling 7-day average. Alert on >20% regression.  
- **Bottleneck heatmap:** After profiling runs, generate a table showing time spent in each processing step (validation, fee fetch, dedup, prepareData, obfuscate, output gen, input selection, change calc, serialization) as percentage of total.

### 7.3 Bottleneck Identification Priority

Based on architectural analysis, these are the most likely optimization targets (in order of expected impact):

1. **`getrawtransaction` per non-SegWit input** -- Each call is a blocking network round-trip. Batching or caching would yield the largest latency reduction for legacy UTXO workloads.
2. **UTXO deduplication loop** -- O(n^2) at 500 UTXOs. Trivial to fix with a `Set` keyed on `txid:vout`.
3. **`bitcoinjs-lib` PSBT construction** -- Library overhead for multi-output P2SH/P2WSH transactions. Not easily optimizable, but worth quantifying.
4. **Express middleware overhead** -- Helmet, rate limiter, body parser add per-request latency. Measurable under high concurrency.
5. **AES-128-CTR obfuscation** -- Only relevant for max-size payloads (65KB). Node.js `crypto` is C-backed so likely negligible.
6. **Event loop blocking** -- Synchronous PSBT operations block the event loop. `worker_threads` could help under concurrent load.

---

## 8. Test Data Requirements

### 8.1 Pre-built Fixtures

| Fixture | Specification | Source |
|---------|--------------|--------|
| SegWit UTXO sets | 1, 5, 10, 50, 100, 500 UTXOs with P2WPKH scriptPubKeys | Extend `utxoFactory.js` |
| Legacy UTXO sets | Same sizes with P2PKH scriptPubKeys | Extend `utxoFactory.js` |
| Mixed UTXO sets | 70% SegWit, 30% legacy | Combine above |
| Small ACTION payloads | SEND v0 (20 bytes), ISSUE v0 (40 bytes) | Use `actionFactory.js` |
| Medium ACTION payloads | MINT with description (500 bytes) | Use `actionFactory.js` |
| Large ACTION payloads | FILE action at 65,536 bytes | Generate random data |
| Custom output sets | 1, 10, 50, 100 payment outputs | Generate with valid addresses |
| Mock RPC responses | Pre-computed `estimatesmartfee` and `getrawtransaction` results | Record from regtest |

### 8.2 Parameterized Test Matrix

The benchmark harness should support a parameterized matrix combining:
- **Encoding type:** OP_RETURN, P2SH, P2WSH, MULTISIGN  
- **Payload size:** minimal, medium, maximum  
- **UTXO count:** 1, 10, 50, 500  
- **UTXO type:** all-SegWit, all-legacy, mixed

This produces 4 x 3 x 4 x 3 = 144 combinations for comprehensive coverage. The CI subset should cover the 12 most representative combinations (one per encoding x payload size, with mixed UTXOs).

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CI benchmark flakiness due to hardware variability | High | Medium | Use dedicated runners; set thresholds at 2x not 1.2x for CI |
| Mocked dependencies masking real-world bottlenecks | Medium | High | Run staging tests with real regtest daemon quarterly |
| `bitcoinjs-lib` version upgrade changes performance characteristics | Low | Medium | Pin version; re-baseline after upgrades |
| Node.js version upgrade affects crypto or GC performance | Low | Low | Document Node.js version in baseline; re-baseline on upgrade |
| Test data doesn't represent production ACTION distribution | Medium | Medium | Analyze production logs to calibrate test weights if available |
