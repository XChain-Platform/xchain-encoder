# XChain Encoder — Smoke Testing Plan

**Date:** 2026-04-02  
**Component:** xchain-encoder  
**Author:** QA Engineering

---

## 1. Objective

Provide a fast, automated health check that confirms the xchain-encoder can launch, initialize its core dependencies, and perform basic ACTION encoding — catching catastrophic failures (broken imports, misconfigured crypto primitives, corrupted encoding logic) within seconds, before deeper test suites run.

Smoke tests answer one question: **"Is the encoder fundamentally operational?"**

---

## 2. Rationale

The encoder is the gateway for every XChain transaction. If it cannot produce a valid PSBT, the entire platform pipeline halts — no transactions get broadcast, decoded, or indexed. A broken encoder deployed to production means:

- No new token transfers (SEND), issuances (ISSUE), or any of the 19 ACTION types can be created.
- All downstream services (decoder, indexer, explorer) become idle.
- Users see immediate, total failure.

Smoke tests provide a sub-10-second gate that catches:

| Failure Class | Example | Impact Without Smoke Test |
|---|---|---|
| **Broken dependency** | `bitcoinjs-lib` upgrade breaks PSBT constructor | Service starts but every `create_tx` call throws |
| **Import/module error** | Renamed file, missing export | Service crashes on first request |
| **Crypto primitive failure** | `tiny-secp256k1` native module not compiled | All signing/key operations fail |
| **Encoding regression** | `prepareData()` chunk math off by one | Silent data corruption in every transaction |
| **Network config corruption** | `CryptoNetworks.js` returns wrong network params | Transactions built for wrong chain |

These are exactly the kinds of failures that full integration tests (which require a running `bitcoind` regtest node) would catch — but only after 30+ seconds of setup. Smoke tests catch them instantly with zero infrastructure.

---

## 3. Critical Smoke Test Scenarios

Scenarios are ordered by priority. All scenarios must pass for the smoke suite to pass.

### S1: Module Loading & Dependency Resolution

**What:** Require all core modules without errors.

**Checks:**
- `require('./src/XChainEncoder')` succeeds
- `require('./src/BlockchainConnector')` succeeds
- `require('./src/CryptoNetworks')` succeeds
- `require('./src/TxSizeEstimator')` succeeds
- `require('./src/UtxoTracker')` succeeds
- `bitcoinjs-lib` is importable and exports `Psbt`, `payments`, `script`, `networks`
- `tiny-secp256k1` native module loads (this is a common failure point after `npm install` on new architectures)

**Why critical:** If any module fails to load, the service is 100% broken. This is the cheapest possible check.

**Expected duration:** <1 second.

---

### S2: Encoder Instantiation

**What:** Construct an `XChainEncoder` instance with each supported network family.

**Checks:**
- `new XChainEncoder('bitcoin-regtest', ...)` creates an instance without throwing
- `new XChainEncoder('dogecoin-regtest', ...)` creates an instance without throwing
- `new XChainEncoder('litecoin-regtest', ...)` creates an instance without throwing
- The returned instance has a valid `network` object (contains `messagePrefix`, `bech32`, `pubKeyHash`, `scriptHash`, `wif` fields)
- The `connector` property (BlockchainConnector) is initialized
- The `dustAmount` property is a positive integer

**Why critical:** Constructor failure means no transactions can ever be created. Network misconfiguration means transactions are built for the wrong chain.

**Expected duration:** <1 second.

---

### S3: CryptoNetworks Integrity

**What:** Verify that all 9 network configurations (3 coins x 3 environments) return valid, distinct network objects.

**Checks:**
- All 9 network strings resolve without error: `bitcoin-mainnet`, `bitcoin-testnet`, `bitcoin-regtest`, `dogecoin-mainnet`, `dogecoin-testnet`, `dogecoin-regtest`, `litecoin-mainnet`, `litecoin-testnet`, `litecoin-regtest`
- Each network object has the required fields (`messagePrefix`, `bech32`, `pubKeyHash`, `scriptHash`, `wif`)
- Mainnet and testnet/regtest configs are distinct (e.g., `pubKeyHash` differs) — prevents accidental mainnet/testnet confusion
- Dust thresholds are positive integers for each network
- Invalid network string throws an error (not a silent null)

**Why critical:** A corrupted network config silently produces transactions for the wrong chain. This is a catastrophic, hard-to-diagnose failure.

**Expected duration:** <1 second.

---

### S4: PSBT Object Creation

**What:** Verify that a raw `bitcoinjs-lib` PSBT can be created and serialized.

**Checks:**
- `new bitcoin.Psbt({ network })` succeeds for bitcoin-regtest
- The PSBT can have an OP_RETURN output added via `addOutput()`
- The PSBT can be serialized to hex via `toHex()`
- The hex output is a non-empty string matching BIP174 prefix pattern
- The PSBT can have a basic input added (with a mock nonWitnessUtxo buffer)

**Why critical:** If the PSBT constructor or serialization is broken (e.g., after a `bitcoinjs-lib` upgrade), no transaction can be produced regardless of encoding path.

**Expected duration:** <1 second.

---

### S5: Data Preparation (prepareData) — All Encoding Types

**What:** Call `encoder.prepareData()` with representative data for each encoding type and verify output structure.

**Checks:**  
- **OP_RETURN encoding:** A short ACTION string (e.g., `SEND|0|JDOG|1|<address>`, ~40 bytes) → returns `{ dataBufferArray: [Buffer], encoding: 'OP_RETURN' }`. Buffer is prefixed with `XCHN` magic word (bytes `58 43 48 4e`). Total chunk size ≤ 80 bytes.  
- **OP_RETURN auto-select:** Passing `encoding=null` with data ≤ 76 bytes → auto-selects `OP_RETURN`.  
- **P2SH encoding:** A medium ACTION string (~200 bytes) with `encoding='P2SH'` → returns chunks each ≤ 520 bytes, encoding is `'P2SH'`.  
- **P2SH auto-select:** Passing `encoding=null` with data > 76 bytes → auto-selects `P2SH`.  
- **P2WSH encoding:** A large payload (~5000 bytes) with `encoding='P2WSH'` → returns chunks each ≤ ~10000 bytes.  
- **MULTISIGN encoding:** A short string with `encoding='MULTISIGN'` → returns chunks each ≤ 71 bytes, prefixed with `XCHN`.  
- **Chunk count correctness:** Data that exceeds a single chunk's capacity produces multiple chunks.

**Why critical:** `prepareData()` is the core logic that splits and formats data before it enters the PSBT. If chunking is wrong, data is silently truncated or corrupted. This check requires no network access.

**Expected duration:** <1 second.

---

### S6: Obfuscation Round-Trip

**What:** Verify that `obfuscate()` encrypts data and that the same function decrypts it (AES-128-CTR is symmetric with same key+IV).

**Checks:**
- `encoder.obfuscate(plaintext, key)` returns a Buffer of the same length as input
- `encoder.obfuscate(ciphertext, key)` returns the original plaintext (CTR mode round-trip)
- Output differs from input (encryption is actually happening)
- Different keys produce different ciphertext
- Empty input produces empty output without error

**Why critical:** Broken obfuscation means the decoder cannot recover ACTION data from transactions. This is a silent, total data-loss scenario.

**Expected duration:** <1 second.

---

### S7: TxSizeEstimator Sanity

**What:** Verify that size estimates return reasonable positive integers.

**Checks:**
- `TxSizeEstimator.estimateOutputSize('OP_RETURN', dataLength)` returns a positive integer
- `TxSizeEstimator.estimateOutputSize('P2SH', ...)` returns a positive integer
- `TxSizeEstimator.estimateInputSize('P2PKH')` returns a value in the expected range (140-150 bytes)
- `TxSizeEstimator.estimateInputSize('P2WPKH')` returns a value smaller than P2PKH (Segwit is more compact)
- No method throws on valid input

**Why critical:** Wrong size estimates → wrong fee calculations → transactions rejected by the network or users overpay. Low cost to verify.

**Expected duration:** <1 second.

---

### S8: Segwit UTXO Detection

**What:** Verify `isSegwitUTXO()` correctly classifies known script patterns.

**Checks:**
- A P2WPKH scriptPubKey (starts with `0014`) → returns `true`
- A P2WSH scriptPubKey (starts with `0020`) → returns `true`
- A P2PKH scriptPubKey (starts with `76a914`) → returns `false`
- A P2SH scriptPubKey (starts with `a914`) → returns `false`

**Why critical:** Misclassification causes the encoder to add the wrong input type to the PSBT (witnessUtxo vs nonWitnessUtxo), producing an invalid transaction that cannot be signed.

**Expected duration:** <1 second.

---

### S9: dataToPubkey Conversion

**What:** Verify that `dataToPubkey()` produces valid-looking compressed public keys from arbitrary data.

**Checks:**
- Input of 31 bytes → output is 33-byte Buffer starting with `0x02`
- Input shorter than 32 bytes is padded correctly
- Output is always exactly 33 bytes (compressed pubkey format)

**Why critical:** MULTISIGN encoding embeds data as fake public keys. If the format is wrong, `bitcoinjs-lib`'s `p2ms()` payment will reject the key and the transaction fails.

**Expected duration:** <1 second.

---

### S10: API Server Startup (Optional — Requires Port)

**What:** Start the Express server and verify it responds to a `ping` request, then shut down.

**Checks:**
- `api.js` starts without throwing (with mock/minimal env vars)
- `POST /` with `{ "jsonrpc": "2.0", "method": "ping", "id": 1 }` returns `{ "result": { "status": "success" } }`
- Server shuts down cleanly

**Why critical:** Verifies the full API stack (Express + helmet + CORS + JSON-RPC router) is wired correctly. Marked optional because it requires a free port and is slightly slower than pure-logic tests.

**Expected duration:** 1-2 seconds.

---

## 4. Scenarios Explicitly Excluded

The following are NOT smoke tests and belong in unit/integration suites:

| Excluded Scenario | Reason |
|---|---|
| Full `createTransaction()` with real UTXOs | Requires a running coin node or complex mocking |
| P2SH two-transaction pattern (tx1 → mine → tx2) | Multi-step workflow, integration-level |
| Fee estimation via `estimatesmartfee` RPC | Requires network access to a coin node |
| UTXO fetching from xchain-utxo-tracker | External service dependency |
| Transaction signing and broadcast | Requires key material and a coin node |
| All 19 ACTION types with decode verification | Comprehensive coverage, belongs in integration suite |
| Browser bundle (`npm run build`) | Build verification, separate concern |
| Error handling (insufficient funds, oversized payloads) | Negative testing, not smoke-level |

---

## 5. Execution Strategy

### 5.1 Script Configuration

```
npm run smoke-test → mocha --timeout 10000 'test/smoke/**/*.test.js'
```

- Smoke tests live in `test/smoke/` — separate from `test/unit/` and `test/integration/`.
- No Mocha root hooks (no `prepareRegtest.test.js` require). Zero infrastructure dependencies.
- Single `describe('Smoke Tests', ...)` block with individual `it(...)` cases for each scenario.

### 5.2 Dependency Strategy

- **No coin node required.** All checks use in-process logic only.
- **No database required.** The encoder has no DB dependency.
- **No network calls.** BlockchainConnector and UtxoTracker are instantiated but never called.
- **No mocking framework needed.** Tests exercise real code with synthetic inputs (hardcoded buffers, known scriptPubKey patterns, short ACTION strings).

### 5.3 CI/CD Pipeline Placement

```
[npm install] → [npm run smoke-test] → [npm run test:unit] → [npm run test:integration] → [deploy]
              ↑                        ↑
              Fails fast (<5s)         More thorough (10-30s)
```

Smoke tests run **immediately after install**, before any other test tier. If smoke tests fail, skip all subsequent test stages — the build is fundamentally broken.

### 5.4 Local Development

Developers should run `npm run smoke-test` after:
- Upgrading `bitcoinjs-lib`, `tiny-secp256k1`, or any crypto dependency
- Modifying `XChainEncoder.js`, `CryptoNetworks.js`, or `TxSizeEstimator.js`
- Changing the module structure (file renames, export changes)

---

## 6. Pass/Fail Criteria

### Suite-Level

| Criterion | Pass | Fail |
|---|---|---|
| **All scenarios complete** | Every `it(...)` block finishes | Any scenario throws an uncaught error |
| **No timeouts** | Suite completes in <10 seconds | Any single scenario exceeds 5 seconds |
| **Exit code** | Process exits with code 0 | Process exits with code ≠ 0 |

### Scenario-Level

| Scenario | Pass Condition |
|---|---|
| S1: Module Loading | All `require()` calls return truthy; expected exports exist |
| S2: Instantiation | Constructor returns an object with expected properties; no throw |
| S3: CryptoNetworks | All 9 networks resolve; fields present; mainnet ≠ testnet |
| S4: PSBT Creation | PSBT constructed, output added, serialized to non-empty hex |
| S5: prepareData | Returns correct structure; chunk sizes within limits; magic word present |
| S6: Obfuscation | Round-trip recovers original; ciphertext ≠ plaintext; lengths match |
| S7: TxSizeEstimator | All estimates are positive integers in plausible ranges |
| S8: Segwit Detection | Correct boolean for each known script pattern |
| S9: dataToPubkey | Output is 33 bytes starting with 0x02 |
| S10: API Startup | Server responds to ping with `{ status: "success" }` |

### Failure Response

When a smoke test fails:

1. **CI pipeline stops immediately** — no point running further tests.
2. **Error output includes:** scenario name, expected vs actual, and the specific module/function that failed.
3. **Developer action:** Fix the root cause (usually a broken import, bad upgrade, or config error) and re-run `npm run smoke-test` before proceeding.

---

## 7. Maintenance Guidelines

- **Keep the suite minimal.** Resist adding edge cases — that's what unit tests are for.
- **No network calls, ever.** The moment a smoke test needs a running service, it's no longer a smoke test.
- **Update when modules change.** If a new core module is added (e.g., a new encoding type), add a corresponding S1 import check and S5 prepareData check.
- **Target: <5 seconds total.** If the suite approaches 10 seconds, audit for unnecessary work.
- **Review quarterly.** Remove scenarios that have never caught a failure; add scenarios for failure modes that slipped through.

---

## 8. Summary

| Property | Value |
|---|---|
| **Scenarios** | 10 (9 mandatory + 1 optional) |
| **Infrastructure required** | None (pure in-process) |
| **Target execution time** | <5 seconds |
| **External dependencies** | None |
| **Pipeline position** | First gate, immediately after `npm install` |
| **Failure action** | Block all downstream stages |

The smoke suite validates that the encoder's foundation — module loading, crypto primitives, data preparation, obfuscation, size estimation, UTXO classification, and API wiring — is intact. It does not test the full transaction-creation pipeline (that requires a coin node), but it ensures that every building block of that pipeline is individually operational.
