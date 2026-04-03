# XChain Encoder: Mutation Testing Plan

## 1. Executive Summary

The `xchain-encoder` has 1,533 lines of source code across 8 modules and an existing test suite of 514 test cases (110 unit, 75 integration, 95 boundary, 131 e2e, 61 chaos, 42 smoke). Code coverage alone cannot determine whether those tests actually _detect_ when logic changes — a test that exercises a line without asserting its output contributes coverage but not confidence. Mutation testing addresses this gap by systematically introducing small code changes (mutants) and verifying that at least one test fails for each.

This plan identifies 187 specific mutation sites across the 6 production source files, defines the mutation operators to apply, recommends Stryker as the tooling framework, and lays out a phased rollout starting with the highest-criticality module (`XChainEncoder.js`).

---

## 2. Codebase Mutation Surface

### 2.1 Source File Inventory

| File | Lines | Role | Mutation Priority |
|------|-------|------|-------------------|
| `XChainEncoder.js` | 576 | Core encoding + PSBT construction | **CRITICAL** |
| `validator.js` | 272 | Input validation (14 functions) | **HIGH** |
| `TxSizeEstimator.js` | 118 | Fee estimation constants + logic | **HIGH** |
| `CryptoNetworks.js` | 131 | Network config mapping | MEDIUM |
| `api.js` | 138 | Express JSON-RPC server | MEDIUM |
| `BlockchainConnector.js` | 196 | RPC client | LOW |
| `UtxoTracker.js` | 83 | UTXO fetch client | LOW |
| `index.js` | 19 | Browser export | SKIP |

### 2.2 Mutation Site Catalog

Below is every location where a small code change could alter behavior. Each entry lists the line, the logic, and which mutation operators apply.

#### XChainEncoder.js (576 lines) — 98 mutation sites

**Constants (lines 31-37)**

| # | Line | Code | Mutation | Impact |
|---|------|------|----------|--------|
| 1 | 31 | `OP_RETURN_SIZE = 80` | Change to 79 or 81 | Auto-selection threshold shifts; chunks sized wrong |
| 2 | 32 | `P2SH_SIZE = 520` | Change to 519 or 521 | P2SH chunk size off-by-one → oversized redeem scripts |
| 3 | 33 | `PW2SH_SIZE = 3615` | Change to 3614 or 3616 | P2WSH chunk boundary shift |
| 4 | 34 | `MULTISIGN_SIZE = 69` | Change to 68 or 70 | MULTISIGN data capacity change |
| 5 | 35 | `MAGIC_WORD = "XCHN"` | Change to `"XCHM"` | All obfuscated payloads have wrong magic → decoder rejects |
| 6 | 37 | `SATOSHI_UNIT = 100000000` | Change to 10000000 | Fee calculation off by 10× |

**isSegwitUTXO() (lines 59-68)**

| # | Line | Code | Mutation | Impact |
|---|------|------|----------|--------|
| 7 | 63 | `script[0] === 0x00` | Change to `!==` or `0x01` | All segwit UTXOs misclassified as legacy |
| 8 | 66 | `return false` | Change to `return true` | Invalid scripts classified as segwit |

**prepareData() (lines 70-172)**

| # | Line | Code | Mutation | Impact |
|---|------|------|----------|--------|
| 9 | 74 | `data.length + magicWordBuffer.length <= OP_RETURN_SIZE` | `<` instead of `<=` | 76-byte payloads forced to P2SH unnecessarily |
| 10 | 74 | Same | `>=` instead of `<=` | All payloads forced to OP_RETURN (overflow) |
| 11 | 86 | `OP_RETURN_SIZE - magicWordBuffer.length` | `+` instead of `-` | Chunk size = 84 instead of 76, overflows OP_RETURN |
| 12 | 91 | `Buffer.concat([magicWordBuffer, nextDataChunk])` | Reverse order | Magic word at end instead of start → decoder fails |
| 13 | 122 | `P2SH_SIZE:PW2SH_SIZE` | Swap values | P2SH uses P2WSH size, P2WSH uses P2SH size |
| 14 | 122 | `- 44` | `- 43` or `- 45` | Chunk size off-by-one |
| 15 | 153-159 | Subtraction chain for MULTISIGN | Change any `-1` to `-0` or `-2` | Chunk size changes → data truncation or overflow |
| 16 | 164 | `Buffer.concat([magicWordBuffer, nextDataChunk])` | Omit magicWordBuffer | MULTISIGN chunks lack magic prefix |

**obfuscate() (lines 174-182)**

| # | Line | Code | Mutation | Impact |
|---|------|------|----------|--------|
| 17 | 175 | `key.substr(0, 16)` | `key.substr(0, 15)` or `key.substr(1, 16)` | Wrong AES key → different ciphertext |
| 18 | 176 | `key.substr(16, 16)` | `key.substr(15, 16)` or `key.substr(16, 15)` | Wrong IV → different ciphertext |
| 19 | 178 | `'aes-128-ctr'` | `'aes-128-ecb'` | Different cipher mode → different output |

**dataToPubkey() (lines 185-195)**

| # | Line | Code | Mutation | Impact |
|---|------|------|----------|--------|
| 20 | 186 | `"02"` prefix | `"03"` | Different pubkey prefix → different multisig address |
| 21 | 188 | `data.length < 32` | `<= 32` or `< 31` | Padding threshold changes |
| 22 | 189 | `32 - data.length` | `33 - data.length` | Buffer oversize → invalid pubkey |
| 23 | 190 | `"00"` fill | `"ff"` fill | Padding bytes change → different pubkey hash |

**createTransaction() (lines 198-562) — 60+ mutation sites**

| # | Line | Code | Mutation | Impact |
|---|------|------|----------|--------|
| 24 | 203 | `feePerKb/1000` | `/100` or `/10000` | Fee rate off by 10× |
| 25 | 207 | `feePerBytes > this.maxFeePerBytes` | `<` or `>=` | Fee cap inverted or off-by-one |
| 26 | 226 | `finalDataBuffer.length > 65536` | `>= 65536` or `> 65535` | Boundary shift ±1 byte |
| 27 | 230 | `encoding === 'P2WSH'` | `!==` | Segwit check inverted |
| 28 | 236 | `replacebyfee? 0x00000001: 0xffffffff` | Swap values | RBF sequence numbers inverted |
| 29 | 256 | `nextUtxo.confirmations == 0` | `=== 1` or `!= 0` | Mempool filtering broken |
| 30 | 264 | `nextUtxoDup.txid == nextUtxo.txid` | Remove `&&` clause | Dedup only checks txid, not vout |
| 31 | 276 | `b.value - a.value` | `a.value - b.value` | Sort ascending → smallest UTXOs first |
| 32 | 303 | `value: 0` | `value: 1` | OP_RETURN output has value → not recognized as data |
| 33 | 353 | Fee calculation `* SATOSHI_UNIT` | Remove multiplication | Fee in BTC not satoshis → wrong by 10^8 |
| 34 | 355 | `< finalDust` | `<= finalDust` or `> finalDust` | Dust floor logic inverted |
| 35 | 417 | `value: finalDust` | `value: 0` | P2WSH output zero-valued → unspendable |
| 36 | 439 | `m: 1` | `m: 2` | Requires 2 signatures instead of 1 → unspendable |
| 37 | 447 | `value: finalDust` | `value: 0` | MULTISIGN output zero-valued |
| 38 | 461 | `parseInt(output.value, 10)` | Remove `, 10` radix | Hex strings parsed differently |
| 39 | 462 | `outputValue < 0` | `<= 0` | Zero-value custom outputs rejected |
| 40 | 470 | `+= 43` | `+= 34` or `+= 0` | Size estimate wrong → fee incorrect |
| 41 | 475 | `+ 43` (change output) | `+ 0` | Change output size not estimated |
| 42 | 490 | `parseInt(nextUtxo.value, 10)` | Remove `, 10` | Hex values parsed as octal |
| 43 | 512 | `inputSatoshis + nextUtxo.value` | `-` instead of `+` | Input tracking inverted |
| 44 | 528 | `estimatedTxSize * feePerBytes * SATOSHI_UNIT` | Remove one operand | Fee calculation broken |
| 45 | 531 | `inputSatoshis > outputSatoshis + estimatedFee` | `>=` or `<` | UTXO loop break condition |
| 46 | 540 | `estimatedFee < this.dustAmount` | `>` or `<=` | Dust floor logic |
| 47 | 544 | `inputSatoshis - outputSatoshis - estimatedFee` | `+` instead of `-` | Change calculation inverted |
| 48 | 550 | `changeSatoshis > this.dustAmount` | `>=` or `<` | Change output threshold |
| 49 | 554 | `changeSatoshis > 0` | `>= 0` or `< 0` | Change output added/omitted incorrectly |

#### validator.js (272 lines) — 52 mutation sites

| # | Category | Lines | Mutations | Count |
|---|----------|-------|-----------|-------|
| 50-61 | Null-check short-circuits | 33,44,52,63,71,86,98,138,170,183,201,209 | Remove `return null` → validation on null input | 12 |
| 62-73 | Comparison operators | 37,57,76,79,91,103,117,123,142,158,174,213 | `>` ↔ `>=`, `<` ↔ `<=` | 12 |
| 74-81 | Logical operators | 34,64,88,110,113,128,191,194 | `&&` ↔ `\|\|`, negate conditions | 8 |
| 82-89 | Boundary constants | 24-27 | `65536` ↔ `65535`, `500` ↔ `499`, `100` ↔ `99`, `2.1T` ↔ `2.1T-1` | 8 |
| 90-96 | Error types | 35,46,58,65,74,77,89 | `TypeError` ↔ `RangeError` | 7 |
| 97-101 | String/regex patterns | 29,30 | Alter `HEX_64_RE` pattern, change `02\|03` to `02\|04` | 5 |

#### TxSizeEstimator.js (118 lines) — 18 mutation sites

| # | Line | Code | Mutation | Impact |
|---|------|------|----------|--------|
| 102 | 28 | `return 11 + data.length` | `10` or `12` | OP_RETURN size estimate ±1 |
| 103 | 33 | `return 32` | `31` or `33` | P2SH output estimate |
| 104 | 37 | `return 43` | `42` or `44` | P2WSH output estimate |
| 105 | 41 | `return 111` | `110` or `112` | MULTISIGN output estimate |
| 106 | 45 | `return 41 + 2 + 72 + redeemData.length` | Change any constant | P2SH input estimate |
| 107 | 70 | `return 350` (fallback) | `180` or `0` | Fallback estimate changes fee |
| 108 | 75 | `return 180` (P2PKH fallback) | `350` or `0` | P2PKH estimate |
| 109 | 88 | `scriptHex.startsWith('0014')` | `'0015'` | P2WPKH detection broken |
| 110 | 90 | `return 68` | `67` or `105` | P2WPKH size wrong |
| 111 | 92 | `scriptHex.startsWith('0020')` | `'0021'` | P2WSH detection broken |
| 112 | 94 | `return 105` | `68` or `104` | P2WSH size wrong |
| 113 | 101 | `startsWith('76a914') && endsWith('88ac')` | Remove one clause | P2PKH detection looser |
| 114 | 102 | `return 180` | `68` or `289` | P2PKH size wrong |
| 115 | 106 | `startsWith('a914') && endsWith('87')` | Remove one clause | P2SH detection looser |
| 116 | 111 | `return 289` | `180` or `350` | P2SH size wrong |
| 117 | 115 | `return 350` (final fallback) | `0` | No fee for unknown scripts |

#### CryptoNetworks.js (131 lines) — 12 mutation sites

| # | Category | Mutations | Count |
|---|----------|-----------|-------|
| 118-123 | Network byte constants | Change `pubKeyHash`, `scriptHash`, `wif` for any network | 6 |
| 124-126 | Dust thresholds | `546` ↔ `547`, `5460` ↔ `5461` | 3 |
| 127-129 | `supportsSegwit` flag | `true` ↔ `false` for Dogecoin configs | 3 |

#### api.js (138 lines) — 7 mutation sites

| # | Line | Code | Mutation |
|---|------|------|----------|
| 130 | 55 | Helmet middleware | Remove call |
| 131 | 58 | JSON body limit `'1mb'` | `'1kb'` |
| 132 | 65 | `key !== API_KEY` | `key === API_KEY` |
| 133 | 76 | Rate limit `60` default | `0` or `1` |
| 134 | 98 | `validator.validateAll(rawParams)` | Remove call |
| 135 | 115 | `err instanceof TypeError \|\| err instanceof RangeError` | Remove one |
| 136 | 118 | `'Internal encoder error'` | Pass through `err.message` |

**Total identified mutation sites: ~136 high-value + ~51 medium-value = ~187**

---

## 3. Mutation Operators

### 3.1 Operator Definitions

| Operator | Code | Description | Applicability |
|----------|------|-------------|---------------|
| **Arithmetic Operator Replacement (AOR)** | `+` ↔ `-`, `*` ↔ `/` | Swap arithmetic ops | Fee calc, size estimation, chunk sizing |
| **Relational Operator Replacement (ROR)** | `>` ↔ `>=`, `<` ↔ `<=`, `==` ↔ `===` | Shift boundary conditions | Validation thresholds, UTXO loop break, dust checks |
| **Logical Operator Replacement (LOR)** | `&&` ↔ `\|\|`, `!x` ↔ `x` | Invert compound conditions | Dedup logic, null checks, encoding selection |
| **Conditional Boundary (CB)** | `> N` → `>= N`, `< N` → `<= N` | Off-by-one on boundaries | Size limits (65536, 500, 100), OP_RETURN 80-byte threshold |
| **Constant Replacement (CR)** | `N` → `N±1`, `N` → `0` | Change numeric literals | Size constants, dust amounts, fee multiplier |
| **String Literal Mutation (SLM)** | `"XCHN"` → `"XCHM"` | Alter string constants | Magic word, cipher algorithm, error messages |
| **Statement Deletion (SD)** | Remove a line | Delete validation, assignment, or return | Error throws, Buffer.concat, outputSatoshis tracking |
| **Return Value Mutation (RVM)** | `return X` → `return !X` | Invert boolean returns | isSegwitUTXO(), validation null returns |
| **Method Call Deletion (MCD)** | Remove a method call | Delete obfuscate(), estimateInputSize() | Crypto, size estimation |
| **Argument Swap (AS)** | `f(a, b)` → `f(b, a)` | Swap function arguments | Buffer.concat order, substr offsets |

### 3.2 Operator Priority for Encoder Context

| Priority | Operators | Rationale |
|----------|-----------|-----------|
| **P1 (Critical)** | CR, AOR, ROR on fee/size math | Fee miscalculation = fund loss |
| **P2 (High)** | CB, LOR on validation bounds | Boundary errors = invalid or rejected transactions |
| **P3 (High)** | SLM on magic word + cipher | Wrong encoding = decoder can't parse |
| **P4 (Medium)** | SD on error throws | Missing validation = security hole |
| **P5 (Medium)** | RVM, AS on UTXO classification | Wrong input type = signing failure |
| **P6 (Low)** | MCD on logging/console | No functional impact |

---

## 4. Tooling: Stryker Mutator

### 4.1 Why Stryker

**StrykerJS** (`@stryker-mutator/core`) is the only production-grade mutation testing framework for JavaScript/Node.js. It supports:

- All mutation operators listed above via built-in mutators
- Mocha as the test runner (matches the project's existing setup)
- Incremental mutation testing (only re-test changed files)
- HTML and JSON reporting
- Parallel execution across CPU cores
- Configurable per-file mutator selection

### 4.2 Configuration

```json
// stryker.conf.json
{
  "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker/master/packages/core/schema/stryker-core.schema.json",
  "mutate": [
    "src/XChainEncoder.js",
    "src/validator.js",
    "src/TxSizeEstimator.js",
    "src/CryptoNetworks.js"
  ],
  "testRunner": "mocha",
  "mochaOptions": {
    "timeout": 30000,
    "spec": [
      "test/unit/**/*.test.js",
      "test/integration/**/*.test.js",
      "test/boundary/**/*.test.js",
      "test/chaos/**/*.test.js"
    ]
  },
  "reporters": ["html", "clear-text", "json"],
  "htmlReporter": {
    "fileName": "reports/mutation/index.html"
  },
  "jsonReporter": {
    "fileName": "reports/mutation/report.json"
  },
  "coverageAnalysis": "perTest",
  "timeoutMS": 30000,
  "concurrency": 4,
  "thresholds": {
    "high": 90,
    "low": 70,
    "break": 60
  }
}
```

### 4.3 Installation

```bash
npm install --save-dev @stryker-mutator/core @stryker-mutator/mocha-runner
```

### 4.4 npm Scripts

```json
"mutate": "npx stryker run",
"mutate:quick": "npx stryker run --mutate 'src/XChainEncoder.js'",
"mutate:validator": "npx stryker run --mutate 'src/validator.js'"
```

---

## 5. Test Suite Selection per Mutation Target

Different test suites have different strengths for killing mutants. The table below maps which suites should run against which source file to maximize kill rate while minimizing execution time.

| Source File | Unit | Integration | Boundary | Chaos | E2E | Rationale |
|-------------|------|------------|----------|-------|-----|-----------|
| `XChainEncoder.js` | Yes | Yes | Yes | Yes | No | Unit tests cover prepareData/obfuscate; integration covers full encoding; boundary covers size limits; chaos covers error paths. E2E requires bitcoind. |
| `validator.js` | No | Yes | Yes | Yes | No | Integration tests exercise validateAll via makeEncoder; boundary tests hit exact limits; chaos F-1 tests validator directly. |
| `TxSizeEstimator.js` | Yes | Yes | Yes | No | No | Unit tests cover each static method; integration tests verify fee calculation end-to-end; boundary tests hit size estimation edge cases. |
| `CryptoNetworks.js` | Yes | Yes | No | No | No | Unit tests verify network configs; integration multi-chain tests verify addresses. |

Excluding E2E tests (which require a running bitcoind) keeps mutation test runs under 5 minutes.

---

## 6. Interpreting Results

### 6.1 Mutant States

| State | Meaning | Action |
|-------|---------|--------|
| **Killed** | At least one test failed when this mutant was active | Good — test suite detects this change |
| **Survived** | All tests passed with the mutant active | **Bad** — test gap; need new or improved assertion |
| **Timeout** | Tests took too long with the mutant (infinite loop) | Treated as killed (mutant detected via behavioral change) |
| **No coverage** | No test reached the mutated code | Different from survived — missing test coverage, not weak assertions |
| **Compile error** | Mutation produced invalid syntax | Ignored (not a meaningful mutant) |

### 6.2 Mutation Score

```
Mutation Score = (Killed + Timeout) / (Total - CompileError - NoCoverage) × 100%
```

| Score | Interpretation |
|-------|---------------|
| >90% | Excellent — test suite is highly effective |
| 80-90% | Good — some gaps worth addressing |
| 70-80% | Fair — significant blind spots |
| <70% | Poor — tests are not catching logic changes |

### 6.3 Predicted Weak Areas

Based on the test suite analysis, these mutation sites are most likely to **survive** (tests won't catch the change):

| Site | Mutation | Why it likely survives |
|------|----------|----------------------|
| `OP_RETURN_SIZE = 80` → `81` | CR | Only boundary tests check the exact 76-byte threshold; a 1-byte increase may not trigger a test failure if no test sends exactly 76 bytes of data |
| `PW2SH_SIZE = 3615` → `3616` | CR | P2WSH chunk boundary is only tested at 3571; a 1-byte change in the constant may not surface |
| `SATOSHI_UNIT = 100000000` → `10000000` | CR | Fee calculation tests may not assert exact fee values precisely enough |
| `estimatedTxSize += 43` | CR | Custom output size estimate; few tests verify exact fee amounts for custom outputs |
| `return 350` (fallback) | CR | TxSizeEstimator fallback; tests may not exercise unknown script types |
| `b.value - a.value` → `a.value - b.value` | AOR | Sort order reversal; tests may not verify which UTXO is consumed first |
| `m: 1` → `m: 2` in p2ms() | CR | MULTISIGN tests verify PSBT structure but may not check the m-of-n value |

These predictions become Phase 1 targets — if they survive, it directly tells us what assertions to add.

---

## 7. Phased Rollout

### Phase 1: XChainEncoder.js Core Logic (Week 1)

**Scope:** Mutate only `src/XChainEncoder.js`
**Test Suite:** unit + integration + boundary + chaos
**Expected Mutants:** ~98
**Estimated Runtime:** ~3 minutes (4 parallel workers, ~30ms per mutant)

**Focus Areas:**
1. Constants (lines 31-37) — CR operator
2. `prepareData()` — AOR, CB, AS operators on chunk sizing
3. `obfuscate()` — SLM, CR operators on key/IV derivation
4. Fee calculation (lines 528, 544, 540) — AOR, ROR operators
5. UTXO loop break condition (line 531) — ROR operator
6. Change output logic (lines 550, 554) — ROR, CB operators

**Expected Outcome:** Baseline mutation score. Predict ~75-85% kill rate based on test suite depth.

**Action on Survivors:**
- Each surviving mutant is a test gap report entry
- Write targeted assertions to kill each survivor
- Re-run to confirm 100% kill rate on addressed mutants

### Phase 2: validator.js (Week 2)

**Scope:** `src/validator.js`
**Test Suite:** integration + boundary + chaos
**Expected Mutants:** ~52
**Estimated Runtime:** ~2 minutes

**Focus Areas:**
1. Null-check short-circuits (all `return null` lines) — SD operator
2. Boundary constants (MAX_DATA_BYTES, MAX_UTXO_COUNT) — CB operator
3. Regex patterns (HEX_64_RE, COMPRESSED_PUBKEY_RE) — SLM operator
4. Error type correctness (TypeError vs RangeError) — SLM operator

**Expected Outcome:** >85% kill rate. The validator has extensive boundary tests.

### Phase 3: TxSizeEstimator.js (Week 2)

**Scope:** `src/TxSizeEstimator.js`
**Test Suite:** unit + integration + boundary
**Expected Mutants:** ~18
**Estimated Runtime:** ~1 minute

**Focus Areas:**
1. Return value constants (68, 105, 180, 289, 350) — CR operator
2. Script pattern matching (`startsWith`, `endsWith`) — SLM operator
3. Arithmetic in `estimateOpReturnOutput` and `estimateP2shInputWithRedeem` — AOR operator

**Expected Outcome:** Moderate kill rate (~70-80%). Size estimation tests verify structural properties more than exact byte counts.

### Phase 4: CryptoNetworks.js + api.js (Week 3)

**Scope:** `src/CryptoNetworks.js`, `src/api.js`
**Test Suite:** unit + integration + chaos
**Expected Mutants:** ~19 (12 + 7)

**Focus Areas:**
- Network byte constants (pubKeyHash, scriptHash, wif)
- Dust threshold values
- `supportsSegwit` flags
- API key comparison logic
- Error sanitization

### Phase 5: Full Codebase Run + Regression Gate (Week 4)

**Scope:** All 4 mutated files simultaneously
**Test Suite:** Full (unit + integration + boundary + chaos)
**Purpose:** Establish the project-wide mutation score as a CI gate

---

## 8. Integration Strategy

### 8.1 Development Workflow

| Event | Action |
|-------|--------|
| **New feature in XChainEncoder.js** | Run `npm run mutate:quick` before merging |
| **New validation rule in validator.js** | Run `npm run mutate:validator` |
| **Any PR touching `src/`** | CI runs targeted mutation on changed files |
| **Weekly** | Full mutation run (`npm run mutate`) with report |

### 8.2 CI Pipeline

| Stage | When | Scope | Gate |
|-------|------|-------|------|
| **PR Check** | Every PR | Mutate only changed `src/` files | Score >= 80% |
| **Nightly** | Scheduled | Full codebase mutation | Score >= 85% |
| **Release** | Before version bump | Full run + HTML report archived | Score >= 90% |

### 8.3 Incremental Mode

Stryker supports `--incremental` mode which caches previous mutation results and only re-tests mutants affected by code changes. This reduces PR-level runs from 3 minutes to ~30 seconds.

```json
"incremental": true,
"incrementalFile": "reports/mutation/stryker-incremental.json"
```

---

## 9. Reporting & Actionable Insights

### 9.1 Report Artifacts

| Artifact | Format | Location | Purpose |
|----------|--------|----------|---------|
| HTML report | Interactive web page | `reports/mutation/index.html` | Visual drill-down per file, per mutant |
| JSON report | Machine-readable | `reports/mutation/report.json` | CI gate evaluation, trend tracking |
| Clear-text summary | Console output | stdout | Developer quick-glance during local runs |

### 9.2 Survivor Analysis Workflow

For each surviving mutant:

1. **Identify the mutation**: What line changed? What operator?
2. **Understand the gap**: Why didn't any test fail?
   - **Missing assertion**: Test runs the code but doesn't check the output
   - **Missing scenario**: No test exercises this code path
   - **Equivalent mutant**: The mutation produces identical behavior (e.g., changing dead code)
3. **Write the fix**:
   - If missing assertion → add assertion to existing test
   - If missing scenario → add new test case
   - If equivalent → mark as `// Stryker disable next-line all` with comment explaining why
4. **Re-run**: Confirm the survivor is now killed

### 9.3 Example Survivor → Test Improvement

**Survivor**: `SATOSHI_UNIT = 100000000` mutated to `10000000` (line 37)
**Analysis**: Fee calculation test checks `impliedFee >= BTC_DUST` but doesn't assert an exact fee value. With SATOSHI_UNIT divided by 10, fee is 10× lower but still ≥ 546 (dust threshold).
**Fix**: Add assertion: `assert.ok(impliedFee > 1000, 'fee should be reasonable for this tx size')` or better: compute expected fee from known tx size and assert within ±10%.

### 9.4 Trend Tracking

Track mutation score over time per file:

```
Date        | XChainEncoder | validator | TxSizeEstimator | Overall
2026-04-03  | 78%           | 87%       | 72%             | 80%
2026-04-10  | 91%           | 93%       | 85%             | 90%
2026-04-17  | 95%           | 95%       | 90%             | 94%
```

---

## 10. Equivalent Mutant Management

Some mutations produce code that behaves identically to the original. These are "equivalent mutants" and cannot be killed by any test. They inflate the denominator and deflate the score.

**Common equivalent mutants in this codebase:**

| Location | Mutation | Why Equivalent |
|----------|----------|---------------|
| `utxos.length == 0` → `utxos.length === 0` | Strict equality on number | `length` is always a number; `==` and `===` behave identically |
| `nextUtxo.confirmations == 0` → `=== 0` | Same | `confirmations` is always a number |
| Console.log/error statements | SD (delete) | No test asserts console output |

**Handling**: Mark with `// Stryker disable next-line all: equivalent mutant` and document the reason. These don't count against the mutation score.

---

## 11. Risk & Effort Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Long runtime on full codebase | Medium | Use incremental mode; limit to 4 source files |
| False positives (equivalent mutants) | Medium | Document and exclude; review each survivor manually |
| Stryker version incompatibility | Low | Pin `@stryker-mutator/core` version in devDependencies |
| Flaky tests causing false kills | Low | Run Stryker with `--tempDirName .stryker-tmp` for isolation |
| Developer overhead interpreting results | Medium | Automate survivor-to-issue pipeline; focus on P1/P2 operators first |

**Estimated Total Effort:**
- Phase 1 setup + first run: 2-3 hours
- Survivor analysis + test fixes per phase: 4-6 hours
- CI integration: 1-2 hours
- Total for all 5 phases: ~25-30 hours over 4 weeks
