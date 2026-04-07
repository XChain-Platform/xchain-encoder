# XChain Encoder: Regression Testing Plan

**Date:** 2026-04-03  
**Component:** xchain-encoder  
**Scope:** Strategy for building and maintaining a comprehensive regression test suite that prevents code changes from breaking existing, stable encoder functionality

---

## 1. Objective

Verify that ongoing code changes -- bug fixes, new features, refactors, ACTION format updates, dependency upgrades, and blockchain primitive library changes -- do not negatively impact existing, stable functionalities of the xchain-encoder. The regression suite is the safety net that protects the encoder's core invariant: **given identical inputs, the encoder must produce structurally identical, decodable PSBTs**.

### 1.1 Why Regression Testing Is Critical for the Encoder

The encoder sits at the entry point of the entire XChain data pipeline. A regression in PSBT construction propagates silently through decoder, indexer, and explorer -- potentially producing invalid on-chain state that is expensive or impossible to correct. Specific risks:

- **Obfuscation key derivation**: A change to how `txidFirstInput` is selected or how AES-128-CTR key/IV are derived would produce PSBTs that deobfuscate to garbage, breaking every downstream service.
- **Chunk boundary logic**: Regressions in `prepareData()` chunk sizing (OP_RETURN 76B, P2SH 476B, P2WSH 3571B, MULTISIG 60B) would silently truncate or corrupt ACTION payloads.
- **Fee/UTXO selection**: Changes to `TxSizeEstimator`, fee calculation, or UTXO sorting could produce transactions that fail to broadcast (insufficient fee) or burn user funds (excessive fee).
- **Two-transaction P2SH/P2WSH pattern**: The tx1 -> tx2 orchestration is fragile; a regression in `p2shHash`/`p2shHex` handling breaks the entire P2SH and P2WSH encoding path.
- **Multi-chain divergence**: Bitcoin, Litecoin, and Dogecoin have different network parameters, dust thresholds, and address formats -- a regression could be chain-specific and hard to detect without explicit coverage.

---

## 2. Scope Definition

The regression test suite is a **curated, prioritized subset** of tests drawn from across all test phases. It is not a separate test directory -- it is a tagged/labeled collection that can be run independently.

### 2.1 What Is Included

#### 2.1.1 Core Unit Tests (from `test/unit/`)

| Test File | Regression-Critical Functions | Rationale |
|---|---|---|
| `XChainEncoder.prepareData.test.js` | Chunk splitting for all 4 encoding types, magic word prefix, boundary sizing | Payload integrity -- any regression here corrupts every transaction |
| `XChainEncoder.obfuscate.test.js` | AES-128-CTR encrypt with txid-derived key/IV | Deobfuscation compatibility with xchain-decoder |
| `XChainEncoder.createTransaction.test.js` | Full PSBT assembly, UTXO selection, fee estimation, change output | Core transaction construction -- the encoder's primary function |
| `XChainEncoder.dataToPubkey.test.js` | Fake pubkey generation for MULTISIGN encoding | Data embedding integrity for multisig path |
| `XChainEncoder.isSegwitUTXO.test.js` | SegWit detection from scriptPubKey | Determines witness vs non-witness input construction |
| `TxSizeEstimator.test.js` | Size estimation for all input/output types | Fee accuracy -- wrong estimates = failed broadcasts or fund loss |
| `CryptoNetworks.test.js` | Network config mapping for all chain/network combos | Multi-chain correctness -- wrong network params = invalid addresses |

#### 2.1.2 Critical Integration Tests (from `test/integration/`)

| Test File | Regression-Critical Scenarios | Rationale |
|---|---|---|
| `action-encoding.test.js` | Real ACTION strings encoded through full pipeline | Validates the ACTION -> PSBT contract |
| `encoding-types.test.js` | All 4 encoding types produce decodable PSBTs | Encoding path coverage |
| `obfuscation-roundtrip.test.js` | Obfuscate -> deobfuscate yields original data | Cross-service compatibility guarantee |
| `utxo-fee.test.js` | UTXO selection and fee calculation with realistic inputs | Financial safety -- prevents fund loss |
| `custom-outputs.test.js` | Custom outputs (e.g., COINPay) correctly added to PSBT | Feature stability for payment outputs |
| `multi-chain.test.js` | Encoding works correctly across Bitcoin, Litecoin, Dogecoin | Chain-specific regression detection |
| `error-handling.test.js` | Error paths for invalid inputs, missing UTXOs, etc. | Validates that error conditions still raise correctly (not silently swallowed) |

#### 2.1.3 Essential E2E Tests (from `test/e2e/`)

| Test File | Regression-Critical Scenarios | Rationale |
|---|---|---|
| `round-trip.e2e.js` | Encode -> decode -> compare ACTION payloads | The ultimate regression check: does the output still decode correctly? |
| `p2sh-p2wsh-sequence.e2e.js` | Full tx1 -> tx2 two-transaction orchestration | Validates the most fragile encoding path end-to-end |
| `action-pipeline.e2e.js` | Multiple ACTION types through the full pipeline | Broad coverage of the ACTION encoding contract |
| `obfuscation-integrity.e2e.js` | Obfuscation produces decodable output through full pipeline | Obfuscation regression detection in realistic context |
| `multi-chain.e2e.js` | Full pipeline on all supported chains | Chain-specific regression detection at E2E level |
| `api-layer.e2e.js` | JSON-RPC API parameter marshalling and response format | API contract stability -- callers depend on response shape |

#### 2.1.4 Smoke Tests (from `test/smoke/`)

| Test File | Regression-Critical Scenarios | Rationale |
|---|---|---|
| `smoke.test.js` | Basic encoder instantiation and minimal PSBT generation | Fastest possible "is it fundamentally broken?" check |

#### 2.1.5 Boundary Tests (from `test/boundary/`)

| Test File | Regression-Critical Scenarios | Rationale |
|---|---|---|
| `data-payload-boundaries.test.js` | Maximum payload sizes for each encoding type | Prevents silent truncation at encoding boundaries |
| `encoding-chunk-boundaries.test.js` | Exact chunk split points (76B, 476B, 3571B, 60B) | Chunk boundary is where regressions are most likely |
| `fee-calculation-boundaries.test.js` | Dust limit enforcement, maxFeePerBytes cap, zero-fee edge | Financial safety at boundary conditions |
| `utxo-value-boundaries.test.js` | Single UTXO exactly covers fee, massive UTXO values | UTXO selection edge cases |

#### 2.1.6 Validator Tests

All tests covering `src/validator.js` functions should be included in the regression suite. The validator is a security boundary -- regressions in input validation could allow malformed data to reach PSBT construction, producing invalid transactions or enabling injection attacks.

### 2.2 What Is Excluded

- **Performance benchmarks**: These have different pass/fail criteria (timing thresholds) that are environment-dependent and should not block a regression run.
- **Chaos engineering tests**: These deliberately inject failures (network drops, resource exhaustion) and test resilience, not correctness of existing behavior.
- **Fuzz tests**: Long-running, non-deterministic by nature -- not suitable for fast regression feedback loops.
- **Mutation testing**: Meta-testing that evaluates test suite quality, not production behavior.

These excluded categories should still be run periodically (nightly, pre-release) but are not part of the core regression suite.

---

## 3. Test Selection Criteria

### 3.1 Inclusion Rules

A test belongs in the regression suite if it meets **any** of these criteria:

1. **Core encoding invariant**: Tests `prepareData()`, `obfuscate()`, `dataToPubkey()`, or PSBT assembly for any encoding type (OP_RETURN, P2SH, P2WSH, MULTISIGN).
2. **Financial safety**: Tests UTXO selection, fee calculation, dust enforcement, change output logic, or the `maxFeePerBytes` cap.
3. **Cross-service contract**: Tests that the encoded output can be deobfuscated/decoded by the decoder's algorithm (round-trip tests).
4. **Security boundary**: Tests input validation in `validator.js` or error paths that prevent malformed data from reaching PSBT construction.
5. **Bug-fix coverage**: Every bug fix to the encoder MUST include a regression test that fails without the fix and passes with it. This test is automatically part of the regression suite.
6. **Multi-chain correctness**: Tests that verify behavior across Bitcoin, Litecoin, and Dogecoin network configurations.
7. **Two-transaction pattern**: Any test exercising the P2SH/P2WSH tx1 -> tx2 flow.

### 3.2 Exclusion Rules

A test should NOT be in the regression suite if:

1. It is non-deterministic (depends on timing, randomness, or external service state).
2. It takes longer than 30 seconds in isolation (move to the nightly full suite).
3. It duplicates coverage already provided by another regression test at a higher fidelity level (prefer integration over unit for the same scenario, E2E over integration).
4. It tests a feature that has been intentionally removed.

### 3.3 Prioritization Tiers

Tests within the regression suite are assigned to tiers that determine execution grouping:

| Tier | Description | Examples | Target Count |
|---|---|---|---|
| **P0 -- Critical** | Tests whose failure means "do not merge" | Round-trip encoding/decoding, fee calculation, PSBT structure validity | 15-25 tests |
| **P1 -- High** | Tests whose failure means "investigate before merge" | Multi-chain encoding, custom outputs, error handling, validator checks | 25-40 tests |
| **P2 -- Standard** | Tests whose failure means "fix within the sprint" | Boundary conditions, edge cases, less common encoding paths | 20-30 tests |

---

## 4. Execution Strategy

### 4.1 When to Run

| Trigger | Suite | Target Duration | Blocking? |
|---|---|---|---|
| **Every commit/push** | P0 (Critical) only | < 30 seconds | Yes -- merge blocked on failure |
| **Pull request** | P0 + P1 (Critical + High) | < 2 minutes | Yes -- merge blocked on failure |
| **Pre-merge to main** | Full regression suite (P0 + P1 + P2) | < 5 minutes | Yes -- merge blocked on failure |
| **Nightly CI** | Full regression + boundary + chaos + fuzz (30 min run) | < 30 minutes | No -- but failures create P1 issues |
| **Pre-release** | Full regression + E2E with live regtest node | < 15 minutes | Yes -- release blocked on failure |

### 4.2 Execution Mechanism

#### 4.2.1 Test Tagging with Mocha Grep

Since the project uses Mocha, regression tests should be tagged using a naming convention that Mocha's `--grep` flag can select:

```bash
# Run P0 regression tests only
npx mocha --timeout 0 --grep "@regression-p0" test/**/*.test.js test/**/*.e2e.js

# Run P0 + P1
npx mocha --timeout 0 --grep "@regression-p[01]" test/**/*.test.js test/**/*.e2e.js

# Run full regression suite
npx mocha --timeout 0 --grep "@regression" test/**/*.test.js test/**/*.e2e.js
```

Tag tests by including the tier marker in the `describe` or `it` block title:

```javascript
// Example (illustrative, not actual test code):
describe('prepareData @regression-p0', function() {
    it('splits OP_RETURN data at 76-byte boundary @regression-p0', function() {
        // ...
    });
});
```

#### 4.2.2 npm Scripts

Add convenience scripts to `package.json`:

```json
{
    "scripts": {
        "test:regression": "mocha --timeout 0 --grep @regression test/**/*.test.js test/**/*.e2e.js",
        "test:regression:p0": "mocha --timeout 0 --grep @regression-p0 test/**/*.test.js test/**/*.e2e.js",
        "test:regression:p1": "mocha --timeout 0 --grep \"@regression-p[01]\" test/**/*.test.js test/**/*.e2e.js"
    }
}
```

### 4.3 Managing Execution Time

| Strategy | Implementation | Expected Impact |
|---|---|---|
| **Tiered execution** | P0 on commit, P0+P1 on PR, full on merge | Reduces commit-time overhead to < 30s |
| **Offline-first tests** | Regression tests should use mocked connectors (no live node) wherever possible | Eliminates regtest startup overhead (~5-10s) |
| **Parallel execution** | Use Mocha `--parallel` flag for independent test files | ~2x speedup for full suite |
| **Shared fixtures** | Centralize UTXO fixtures and encoder instances in `beforeAll` hooks | Reduces per-test setup time |
| **Skip slow E2E in fast mode** | Live-node E2E tests only in nightly and pre-release runs | Keeps PR suite under 2 minutes |
| **Monitor test timing** | Track execution time per test file; flag any test exceeding 5s for optimization | Prevents gradual suite bloat |

---

## 5. Maintenance & Management Plan

### 5.1 Process for Adding Tests

1. **Bug fixes**: Every bug fix PR MUST include a new regression test that:
   - Fails on the branch before the fix (verified by the reviewer)
   - Passes after the fix
   - Is tagged with `@regression-p0` (bugs in core logic) or `@regression-p1` (bugs in secondary paths)
   - Includes a comment referencing the bug (e.g., `// Regression: fixes incorrect P2SH chunk size for payloads exactly 476 bytes`)

2. **New features**: When a new encoding type, ACTION format, or API parameter is added:
   - Add unit and integration tests during feature development (these are NOT automatically regression tests)
   - Once the feature is stable (shipped and validated in at least one release), promote key tests to the regression suite by adding the `@regression` tag
   - Do not add tests for in-progress features to the regression suite -- unstable tests produce false failures

3. **Refactors**: When refactoring internal logic:
   - Run the full regression suite BEFORE starting the refactor to establish a baseline
   - Run the full regression suite AFTER the refactor -- all tests must pass without modification
   - If a regression test must be modified to accommodate the refactor, this is a signal that behavior changed. Document the behavioral change explicitly in the PR description.

### 5.2 Process for Removing/Updating Tests

1. **Obsolete tests**: A test is obsolete when the feature it covers has been intentionally removed. Remove it in the same PR that removes the feature.
2. **Changed behavior**: When an ACTION format changes or an encoding type is modified, update the regression test to reflect the new expected behavior. The PR must document why the old behavior was wrong or no longer needed.
3. **Flaky tests**: A test that fails intermittently is worse than no test -- it erodes trust in the suite. If a regression test becomes flaky:
   - First, investigate and fix the root cause (usually test isolation issues or timing dependencies)
   - If the fix is non-trivial, temporarily demote to P2 (not remove) and file a P1 issue to fix it
   - Never `skip` a regression test without a tracking issue

### 5.3 Tracking & Reporting

#### 5.3.1 CI Integration

- Regression test results should be visible in CI pipeline output (GitHub Actions, or equivalent)
- Use Mocha's `--reporter json` or `mocha-junit-reporter` to produce machine-readable results
- CI should produce a summary showing: total tests, passed, failed, skipped, duration

#### 5.3.2 Failure Triage Process

| Severity | Condition | Response |
|---|---|---|
| **Blocker** | Any P0 test fails | Merge is blocked. Author fixes before re-review. |
| **Critical** | Any P1 test fails | Merge is blocked. Author investigates; may be waived by reviewer if failure is unrelated to the change. |
| **Standard** | Any P2 test fails | Merge is not blocked. Issue filed for fix within current sprint. |
| **Flaky** | Test fails on retry but passes on re-run | File a flakiness issue. If the test is P0/P1, fix within 48 hours. |

#### 5.3.3 Regression Suite Health Metrics

Track the following monthly:

- **Total regression test count** by tier (P0/P1/P2)
- **Suite execution time** (commit / PR / full)
- **Flaky test count** (tests that failed then passed on retry in the last 30 days)
- **Coverage delta** (regression suite coverage % change after code changes)
- **Mean time to fix** regression failures

---

## 6. Relationship to Other Test Phases

The regression suite does not exist in isolation -- it draws from and complements every other test phase. The key principle is: **the regression suite is a curated view, not a separate body of tests**.

### 6.1 Test Phase Integration Map

```
┌─────────────────────────────────────────────────────────────────┐
│                    REGRESSION SUITE                             │
│  (curated selection, tagged with @regression-p0/p1/p2)         │
│                                                                 │
│  ┌──────────┐ ┌─────────────┐ ┌──────┐ ┌─────────┐ ┌────────┐│
│  │  Unit    │ │ Integration │ │ E2E  │ │ Smoke   │ │Boundary││
│  │  Tests   │ │ Tests       │ │Tests │ │ Tests   │ │ Tests  ││
│  │ (core)   │ │ (pipeline)  │ │(full)│ │ (quick) │ │ (edge) ││
│  └──────────┘ └─────────────┘ └──────┘ └─────────┘ └────────┘│
└─────────────────────────────────────────────────────────────────┘
         ↑               ↑            ↑
         │               │            │
    Promote when     Promote when   Promote when
    logic is stable  pipeline proven feature ships
```

### 6.2 Phase-by-Phase Relationship

#### Unit Tests (`test/unit/`)
- **Relationship**: Regression suite includes the subset of unit tests that cover core encoding invariants (prepareData, obfuscate, dataToPubkey, isSegwitUTXO, TxSizeEstimator, CryptoNetworks).
- **What stays unit-only**: Tests for internal helper behavior that is not externally observable (e.g., testing that a private helper returns a specific intermediate value).
- **Promotion path**: A unit test becomes a regression test when the function it covers is considered stable and its correct behavior is critical to the encoder's output.

#### Integration Tests (`test/integration/`)
- **Relationship**: Regression suite includes integration tests that validate the encoder's contract with its inputs and outputs (ACTION encoding, encoding type selection, obfuscation round-trip, UTXO/fee interaction).
- **What stays integration-only**: Tests for obscure error paths or uncommon parameter combinations that are useful for development but not critical for regression detection.
- **Promotion path**: Integration tests are promoted once the scenario they cover has been validated in production or regtest environments.

#### E2E Tests (`test/e2e/`)
- **Relationship**: Regression suite includes E2E tests that validate the full pipeline (round-trip, P2SH/P2WSH sequence, API layer). These are the highest-fidelity regression tests but also the slowest.
- **Execution note**: E2E regression tests that require a live node are only run in nightly and pre-release pipelines. Offline E2E tests (mocked I/O boundaries) can run on every PR.
- **Promotion path**: E2E tests are promoted after the scenario is stable across at least two releases.

#### Smoke Tests (`test/smoke/`)
- **Relationship**: All smoke tests are automatically part of the regression suite at P0. Smoke tests ARE regression tests -- they verify the most fundamental "does it work at all?" invariants.
- **Execution note**: Smoke tests run first in every regression execution and should complete in < 5 seconds.

#### Boundary Tests (`test/boundary/`)
- **Relationship**: Regression suite includes boundary tests for encoding chunk limits, fee boundaries, and UTXO value edges. These are high-value regression tests because boundary conditions are where regressions are most likely to appear.
- **What stays boundary-only**: Exhaustive combinatorial boundary exploration that is useful for initial validation but too slow for regression runs.

#### Fuzz Tests (planned/future)
- **Relationship**: Fuzz tests are NOT included in the regression suite. However, when a fuzz run discovers a bug, the minimal reproducing case MUST be converted into a deterministic regression test and added to the suite.
- **Pattern**: Fuzz -> Bug discovered -> Minimal reproducer -> Regression test added at P0.

#### Chaos Engineering Tests (`test/chaos/`)
- **Relationship**: Chaos tests are NOT included in the regression suite. They test resilience under failure conditions, not correctness of stable behavior.
- **Exception**: If a chaos test reveals that the encoder fails to handle a previously-handled failure mode (e.g., a refactor removed error handling for network timeouts), the specific failure-mode test should be added to the regression suite.

---

## 7. Regression Test Coverage Map

The following matrix maps encoder source modules to their regression test coverage, identifying gaps:

| Source Module | Core Functions | Unit Regression | Integration Regression | E2E Regression | Gap? |
|---|---|---|---|---|---|
| `XChainEncoder.js` | `createTransaction()` | createTransaction tests | action-encoding, encoding-types | round-trip, action-pipeline | No |
| `XChainEncoder.js` | `prepareData()` | prepareData tests | encoding-types | encoding-boundaries | No |
| `XChainEncoder.js` | `obfuscate()` | obfuscate tests | obfuscation-roundtrip | obfuscation-integrity | No |
| `XChainEncoder.js` | `dataToPubkey()` | dataToPubkey tests | (via encoding-types) | (via action-pipeline) | No |
| `XChainEncoder.js` | `isSegwitUTXO()` | isSegwitUTXO tests | utxo-fee | utxo-fee-change | No |
| `XChainEncoder.js` | `estimateSpendingP2shTx()` | (indirect) | (via encoding-types) | p2sh-p2wsh-sequence | **Minor** -- no direct unit test |
| `TxSizeEstimator.js` | All estimation methods | TxSizeEstimator tests | utxo-fee | utxo-fee-change | No |
| `CryptoNetworks.js` | `getBitcoinJsNetwork()` | CryptoNetworks tests | multi-chain | multi-chain | No |
| `BlockchainConnector.js` | `getFeePerKilobyte()`, `getTransactionHex()` | (mocked in tests) | utxo-fee, error-handling | api-layer | No |
| `UtxoTracker.js` | `getUtxosFromAddress()` | (mocked in tests) | utxo-fee | api-layer | No |
| `validator.js` | All `validate*()` functions | (needs dedicated tests) | error-handling | error-rejection | **Gap** -- needs unit regression tests |
| `api.js` | JSON-RPC `create_tx` handler | (via api.test.js) | (indirect) | api-layer | No |

### 7.1 Identified Gaps & Recommendations

1. **`validator.js` unit regression tests**: The validator module has comprehensive validation logic but needs dedicated unit tests in the regression suite. Each `validate*()` function should have tests for valid input, invalid input, and boundary values.

2. **`estimateSpendingP2shTx()` direct unit test**: This function is tested indirectly through P2SH encoding tests, but a direct unit test would catch regressions in the size estimation formula more quickly.

3. **Dogecoin/Litecoin-specific regression tests**: While `multi-chain.test.js` and `multi-chain.e2e.js` cover multi-chain scenarios, ensure there are specific regression tests for:
   - Litecoin HogEx flag stripping
   - Dogecoin AuxPoW header handling
   - Chain-specific dust threshold enforcement

---

## 8. Implementation Roadmap

### Phase 1: Tag Existing Tests (Week 1)

1. Audit all existing test files listed in Section 2.1
2. Add `@regression-p0`, `@regression-p1`, or `@regression-p2` tags to test titles
3. Add `npm run test:regression` scripts to `package.json`
4. Verify that `npx mocha --grep @regression` selects the correct tests
5. Baseline: record total count, execution time, and pass rate

### Phase 2: Fill Coverage Gaps (Week 2)

1. Add dedicated `validator.js` unit tests with `@regression-p1` tags
2. Add direct unit test for `estimateSpendingP2shTx()` with `@regression-p1` tag
3. Add chain-specific regression tests for Dogecoin and Litecoin edge cases
4. Review boundary tests and promote critical ones to regression suite

### Phase 3: CI Integration (Week 3)

1. Add P0 regression run to the commit/push pipeline stage
2. Add P0+P1 regression run to the PR pipeline stage
3. Add full regression run to the pre-merge pipeline stage
4. Configure nightly full suite run (regression + boundary + chaos)
5. Set up result reporting (JSON/JUnit output, CI summary)

### Phase 4: Ongoing Maintenance (Continuous)

1. Enforce "bug fix = regression test" rule in PR review checklist
2. Monthly regression suite health review (metrics from Section 5.3.3)
3. Quarterly test audit: remove obsolete tests, promote stable feature tests, fix flaky tests
4. Track and address coverage gaps as new features are added

---

## 9. Success Criteria

The regression testing strategy is successful when:

1. **Zero undetected regressions** reach production -- every regression is caught before merge
2. **P0 suite runs in < 30 seconds** on every commit
3. **Full suite runs in < 5 minutes** on every merge
4. **Flaky test rate < 2%** (fewer than 1 in 50 tests fails intermittently)
5. **100% bug-fix coverage** -- every encoder bug fix has a corresponding regression test
6. **All encoding types covered** -- OP_RETURN, P2SH, P2WSH, and MULTISIGN all have P0 regression tests
7. **All chains covered** -- Bitcoin, Litecoin, and Dogecoin all have regression tests at P1 or higher
