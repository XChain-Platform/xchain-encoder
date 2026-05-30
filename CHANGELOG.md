# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo (previously git-ignored) and the Docker image is built with `npm ci` instead of `npm install`. `npm ci` installs the exact dependency tree recorded in the lockfile and fails the build if the lockfile is missing or out of sync with `package.json`, so a container image can no longer silently pick up newer transitive dependency versions than were tested.

### Tests
- Added an end-to-end `createTransaction` regression test covering a short final `MULTISIGN` chunk (compiled payload of 88 bytes → chunks of 60 + 28, last chunk's data portion = 28 bytes). This exercises the previously-failing path through `p2ms()` construction — before chunks were padded to a full 64-byte slot, the final chunk left the second pubkey half empty and `dataToPubkey()` produced an x=0 point that `bitcoinjs-lib` rejected (`Expected property 'pubkeys.1' of type isPoint`). The existing `prepareData` test only asserted chunk sizes structurally; this one asserts the full encode succeeds and emits one well-formed 1-of-3 output per chunk. Uses a brute-forced txid so every obfuscated pubkey half is a valid secp256k1 point.

## [1.6.9] - 2026-05-29

### Added
- `UtxoTracker` now performs a sync-status pre-flight before every UTXO query. `getUtxosFromAddress()` first calls the tracker's `get_sync_status` JSON-RPC method and refuses to fetch UTXOs when the tracker is lagging the chain tip by more than 3 blocks (mirroring the tracker's own sync threshold), or when the tracker has not yet indexed any blocks (`lag` is null). Previously, when the tracker trailed the node tip — common on dense chains like Dogecoin during catch-up ingestion — the encoder would silently fetch a stale UTXO set, potentially selecting already-spent outputs and building transactions the network rejects. The guard converts that silent failure mode into an explicit, catchable `Error` carrying the current lag, which propagates through the existing error handling in `api.js` (`get_utxos`) and `XChainEncoder.createTransaction()`. Added a `getSyncStatus()` helper sharing the same 15-second abort timeout as the UTXO query.

## [1.6.8] - 2026-05-29

### Fixed
- Every JSON-RPC request the encoder makes to a coin node (`BlockchainConnector`: `getNetworkInfo`, `isRegtest`, `getTransactionHex`, `sendRawTransaction`, `getFeePerKilobyte`) and every UTXO query it makes to the UTXO tracker (`UtxoTracker.getUtxosFromAddress`) now aborts after a 15-second timeout via `AbortController`. Previously these `fetch` calls had no timeout, so an unresponsive coin node or UTXO tracker would hang the call indefinitely and block the PSBT-building request with no fail-fast path. The abort surfaces through the existing error handling, so callers see a thrown error instead of an indefinite stall. This matches the request timeouts already configured by the other connectors in the platform.

## [1.6.7] - 2026-05-29

### Fixed
- `getFirstBlock()` now returns the correct first scanned block for Litecoin and Dogecoin networks instead of silently returning `0`. Added `litecoin-mainnet` (3,000,000), `litecoin-testnet` (4,470,000), `dogecoin-mainnet` (6,000,000), and `dogecoin-testnet` (19,900,000), and corrected `bitcoin-testnet` from `0` to `100,000`. These now match the decoder's ingest floors so the two services agree on the first block scanned per network; previously any encoder caller anchoring a scan or filter window on these networks would have started at genesis. All regtest networks continue to start at block `0` via the `default` case.

## [1.6.6] - 2026-05-29

### Changed
- `getFirstBlock()` for `bitcoin-mainnet` now returns `900000` instead of `844000`, matching the decoder's mainnet ingest floor. The two services must agree on the first block scanned on mainnet; they previously disagreed by 56,000 blocks, which would have left the encoder treating a range as in-scope that the decoder never ingests. Pre-launch change with no effect on already-encoded data.

## [1.6.5] - 2026-05-28

### Fixed
- Aligned the maximum payload size across the encoder with the decoder's hard ingest limit. The inner encode guard now rejects payloads whose compiled size exceeds 8,195 bytes (8,192 decompiled characters) instead of 65,536, and the API pre-validation gate (`MAX_DATA_BYTES`) is lowered from 65,536 to 8,192 to match. Previously the encoder accepted payloads up to 65,536 bytes that the decoder silently drops on ingest — so a large FILE/BATCH payload in the 8,193–65,536 byte range could be encoded, broadcast, and mined but never recorded, with fees unrecoverable. The two gates now reject such payloads consistently at encode time. Chaos boundary tests updated to the 8,195-byte compiled limit.

## [1.6.4] - 2026-05-28

### Fixed
- Multi-chunk `MULTISIGN` encoding now zero-pads every chunk to a full 64-byte slot before splitting it across the two data-carrying pubkey halves. Previously a short final chunk left the second 32-byte half empty or near-empty, which produced an all-zero / low-entropy point that `bitcoinjs-lib` rejected (`Expected property 'pubkeys.1' of type isPoint`) — breaking any `MULTISIGN` payload whose compiled size was not an exact multiple of 60. The reader already recovers the original payload via the compiled script's self-describing length, so the trailing pad is invisible end-to-end and no decoder change is required.

## [1.6.3] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths, including the legacy `qs@6.5.5` pulled in by the deprecated `request` package.

## [1.6.2] - 2026-04-07

### Added
- `sendRawTransaction(txHex)` method on `BlockchainConnector` — broadcasts signed transactions to the coin node via `sendrawtransaction` JSON-RPC
- `broadcast_tx` JSON-RPC method in `api.js` — exposes transaction broadcasting via the encoder's RPC interface
- `get_utxos` JSON-RPC method in `api.js` — exposes UTXO queries by proxying to the xchain-utxo-tracker service

## [1.6.1] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [1.6.0] - 2026-04-06

### Added
- `feeQuote` parameter for `create_tx` — automatically adds a protocol fee output to the PSBT when provided with `{ address, amount }` from the hub's `getfeequote` endpoint
- `validateFeeQuote()` in validator.js — validates address (string, max 100 chars) and amount (positive integer, max 2.1T satoshis)

## [1.5.1] - 2026-04-05

### Changed
- Moved Stryker mutation configs (`stryker.conf.json`, `stryker.conf.quick.json`) from project root into `test/mutation/`
- Updated `mutate` and `mutate:quick` npm scripts to reference new config paths

## [1.5.0] - 2026-04-03

### Added
- Regression test suite (`test/regression/`) with 196 tests across 8 files covering all critical encoder paths
- `reg-01-encoding-types.test.js` — all 4 encoding types (OP_RETURN, P2SH, P2WSH, MULTISIGN) produce valid PSBTs
- `reg-02-obfuscation.test.js` — AES-128-CTR round-trip, key derivation, TXID sensitivity, P2SH/P2WSH markers
- `reg-03-fee-utxo.test.js` — UTXO selection/sort, deduplication, fee calculation, dust floor, change output, tracker fallback
- `reg-04-validator.test.js` — dedicated coverage for all validate* functions in src/validator.js (fills identified coverage gap)
- `reg-05-multi-chain.test.js` — Bitcoin, Litecoin, Dogecoin network configs, dust thresholds, P2WSH segwit restriction
- `reg-06-p2sh-p2wsh-sequence.test.js` — tx1→tx2 chaining integrity for P2SH and P2WSH encoding
- `reg-07-action-pipeline.test.js` — SEND, ISSUE, MULTISEND, ORDER, BROADCAST, FILE, BATCH, rawData, special characters
- `reg-08-api-contract.test.js` — validateAll→createTransaction parameter flow, error classification, PSBT serialization
- `npm run test:regression` script
- Regression testing strategy report at `reports/XCHAIN_ENCODER_REGRESSION_TESTING_PLAN.md`

## [1.4.0] - 2026-04-03

### Added
- Mutation testing with StrykerJS v8 targeting XChainEncoder.js, validator.js, TxSizeEstimator.js, and CryptoNetworks.js
- `stryker.conf.json` — full mutation config running unit/integration/boundary/chaos tests against 896 mutants across 4 source files
- `stryker.conf.quick.json` — incremental config for PR-level checks (XChainEncoder.js only, ~47s)
- `npm run mutate` and `npm run mutate:quick` scripts
- Mutation testing plan report at `reports/XCHAIN_ENCODER_MUTATION_TESTING_PLAN.md` cataloging 187 high-value mutation sites
- Baseline mutation scores: XChainEncoder.js 83.3%, TxSizeEstimator.js 82.8%, CryptoNetworks.js 72.7%, validator.js 55.6%
- `@stryker-mutator/core` and `@stryker-mutator/mocha-runner` added as devDependencies

## [1.3.0] - 2026-04-03

### Added
- Chaos engineering test suite (`test/chaos/`) with 61 tests across 6 categories: network/dependency failures, input corruption, library monkey-patch failures, arithmetic edge cases, resource exhaustion, and API layer resilience
- Test categories: ECONNREFUSED/timeout/malformed RPC responses (A-1..A-7), empty UTXO array after dedup, degenerate AES keys, max payload boundaries, corrupted scriptPubKeys (B-1..B-6), Psbt.addInput/addOutput/toHex and crypto.createCipheriv monkey-patch injection (C-1..C-5), fee overflow and insufficient UTXO detection (D-1..D-4), 500-UTXO and 65KB payload stress (E-1..E-2), validator fuzzing and api.js toHex exposure (F-1..F-3)
- `npm run test:chaos` script
- Chaos engineering plan report at `reports/XCHAIN_ENCODER_CHAOS_ENGINEERING_PLAN.md`
- Documented known issues: unguarded empty UTXO array crash (B-1), silent fund loss on negative change (D-1), insufficient UTXOs returning valid PSBT (D-2), psbt.toHex() outside try/catch in api.js (F-3)

## [1.2.0] - 2026-04-03

### Added
- Performance and load testing suite (`test/performance/`) with 27 benchmark scenarios covering all encoding types, UTXO scaling, and payload size matrices
- `bench.js` — standalone benchmark harness with CLI flags (`--full`, `--scenario`, `--json`, `--warmup`, `--iters`) measuring per-encoding throughput, latency percentiles, memory, and GC pauses
- `soak.js` — sustained-duration leak and latency drift detector with 10-second window summaries and automatic warnings
- k6 API load test scripts: `sustained.js` (constant 100 req/sec), `spike.js` (burst to 500 req/sec), `concurrent.js` (ramp 1-100 VUs)
- Metrics helpers: Histogram (nanosecond-precision), MemoryTracker, GcTracker, EldTracker, ASCII report formatter, JSON report writer
- Pre-built fixture library reusing existing utxoFactory and actionFactory test helpers
- `npm run bench`, `bench:full`, `bench:soak`, `bench:k6` scripts
- Performance testing plan report at `reports/XCHAIN_ENCODER_PERFORMANCE_TESTING_PLAN.md`

## [1.1.0] - 2026-04-03

### Added
- `src/validator.js` — centralized input validation module with 14 validators for all `createTransaction` parameters (types, ranges, formats, array limits)
- API key authentication middleware (opt-in via `API_KEY` env var, checks `x-api-key` header)
- Rate limiting via `express-rate-limit` (configurable via `RATE_LIMIT_RPM`, default 60 req/min)
- CORS restriction (configurable via `CORS_ORIGIN` env var, default disabled)
- Request body size limit (1 MB) on JSON-RPC endpoint
- Payload size hard limit (64 KB) on combined `data` + `rawData`
- P2WSH encoding blocked on Dogecoin networks (no bech32 support)
- `supportsSegwit: false` flag on all Dogecoin network configs in CryptoNetworks
- P2WSH `p2shTx.outs` bounds check before accessing output by index
- `changeSatoshis` NaN guard — throws RangeError if fee arithmetic produces non-finite result
- Security audit plan report at `reports/XCHAIN_ENCODER_SECURITY_AUDIT_PLAN.md`

### Fixed
- `customOutputs` value parsing now uses `parseInt(value, 10)` with NaN and negative guards — prevents silent NaN propagation that could burn all change as miner fees
- UTXO value parsing now uses `parseInt(value, 10)` with NaN guard — prevents hex string interpretation and silent arithmetic corruption
- Explicit `fee` parameter now validated as non-negative integer — previously accepted NaN, negative, or non-numeric values
- `prepareData()` now throws TypeError for unknown encoding instead of returning null (which caused opaque TypeError downstream)
- `CryptoNetworks.getBitcoinJsNetwork()` now throws TypeError for unknown network names instead of returning undefined (which crashed the process on startup)
- Error sanitization in API layer — TypeError/RangeError messages forwarded, all other errors return generic "Internal encoder error" to prevent information leakage
- Change address error message no longer leaks exact wallet balance in satoshis

### Changed
- `api.js` validation layer: all parameters validated via `validator.validateAll()` before reaching encoder
- `express-rate-limit` added as production dependency

## [1.0.0] - 2026-04-02

### Changed
- Bumped version to 1.0.0

## [0.1.5] - 2026-04-02

### Added
- Boundary test suite (95 tests) verifying encoder behavior at exact parameter limits and edge cases
- Test categories: encoding chunk boundaries (OP_RETURN/P2SH/P2WSH/MULTISIGN split thresholds), fee calculation extremes, change address dust boundaries, UTXO value edge cases, custom output parseInt truncation, UTF-8/null-byte data payloads, obfuscation with degenerate TXIDs, and TxSizeEstimator fallback behavior
- `npm run test:boundary` script
- Boundary testing plan report at `reports/XCHAIN_ENCODER_BOUNDARY_TESTING_PLAN.md`

### Fixed
- MULTISIGN_SIZE reduced from 71 to 69 — previous value allowed chunk sizes that produced oversized fake pubkeys (>33 bytes), causing `p2ms()` to reject data payloads of 60+ compiled bytes
- PW2SH_SIZE reduced from 10000 to 3615 — previous value exceeded bitcoinjs-lib's 3600-byte redeem script limit, causing all P2WSH payloads over ~3568 chars to throw
- TxSizeEstimator.estimateInputSize() now returns 350 (conservative fallback) instead of null when UTXO data is missing — null silently coerced to 0 in JavaScript arithmetic, causing fee underestimation

## [0.1.4] - 2026-04-02

### Added
- End-to-end test suite (157 tests) validating the full encoding pipeline from ACTION configuration input to PSBT output
- Test categories: full ACTION-to-PSBT pipeline (all 19+ ACTION types, all SEND versions v0-v3), two-transaction P2SH/P2WSH orchestration with data fidelity verification, encoding type boundaries, obfuscation integrity, UTXO/fee/change integration, multi-chain validation (BTC/DOGE/LTC), complex parameter edge cases (unicode, zero amounts, big numbers, custom dust), error rejection, and round-trip encoder-decoder consistency
- Tier 2 API layer tests (JSON-RPC endpoint validation, CORS, concurrency) that auto-skip when server is not running
- E2E testing plan report at `reports/XCHAIN_ENCODER_E2E_TESTING_PLAN.md`

## [0.1.3] - 2026-04-02

### Added
- Smoke test suite (52 tests) for fast health-check validation of all core building blocks: module loading, encoder instantiation, CryptoNetworks integrity, PSBT creation, prepareData (all 4 encoding types), obfuscation round-trip, TxSizeEstimator, Segwit UTXO detection, dataToPubkey, and API server startup
- `npm run smoke-test` script — runs in under 1 second with zero infrastructure dependencies
- Smoke testing plan report at `claude/reports/XCHAIN_ENCODER_SMOKE_TESTING_PLAN.md`

## [0.1.2] - 2026-04-02

### Added
- Integration test suite (108 tests) verifying encoder behavior across all integration points without requiring a live bitcoind
- Test categories: ACTION payload encoding fidelity (all 19 ACTION types), encoding type integration (OP_RETURN/P2SH/P2WSH/MULTISIGN), obfuscation round-trip, UTXO & fee handling, custom outputs, multi-chain (BTC/DOGE/LTC), and error handling
- Shared test helpers: deobfuscation utility, UTXO fixture factory, ACTION payload factory
- `npm run test:integration` script
- Integration testing plan report at `reports/XCHAIN_ENCODER_INTEGRATION_TESTING_PLAN.md`

## [0.1.1] - 2026-04-02

### Added
- Comprehensive unit test suite (114 tests) covering all encoder modules: prepareData, obfuscate, dataToPubkey, isSegwitUTXO, TxSizeEstimator, CryptoNetworks, and createTransaction
- `npm run test:unit` script for running unit tests without external dependencies

## [0.1.0] - 2026-04-02

### Added
- Implement customOutputs support in createTransaction: adds arbitrary payment outputs to PSBTs alongside OP_RETURN data, with proper value tracking and fee estimation (enables COINPay native coin payments)
