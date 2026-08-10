# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `npm run ci` runs the roundtrip conformance suite, so an encoder that stops producing the golden fixture bytes no longer passes CI ().
- `CORS_ORIGIN` now accepts a comma-separated allowlist matched per-origin, instead of echoing a multi-value header that no browser accepts .
- OP_RETURN 76-byte ceiling enforced pre-compile as -32602 invalid-params; manifest fixture re-vendored.
- Parse satoshi/fee money fields exactly (`parseSatoshiAmount`, `validateFee`, `validateDust`, `validateFeeQuote`) so `"1e8"`, `"100.5"`, `"5abc"` and other non-integer strings are rejected instead of `parseInt`-truncated to a silently-wrong amount.
- Default an omitted `data` param to `''` in `createTransaction` so a spec-valid data-omitted request builds a payment-only tx instead of crashing on `Buffer.from(null)`.
- Validate `utxos[].scriptPubKey` as bounded even-length hex so a malformed value is rejected up front instead of silently truncating through `Buffer.from(x, 'hex')` and misclassifying the input.
- Bind the obfuscation key to ins[0] by construction and fail closed when selection races a reservation, so a lapsed foreign reservation can no longer silently void an OP_RETURN/MULTISIGN action ().
- Size P2WSH witness-stack items with compactSize varint framing instead of the script-push formula ().

## [1.6.11] - 2026-07-16

### Fixed
- rbf/unconfirmed validated as strict booleans (TypeError -> -32602) instead of truthiness-coerced, so string "false" can no longer flip UTXO-selection policy ().
- health() and GET /status apply create_tx's maxUtxoTrackerLagBlocks overLag gate so serve-readiness matches what create_tx will actually accept ().


## [1.6.10] - 2026-06-20

### Added
- Validate `tx_hex` shape and length in `broadcast_tx`, and `p2shHex` in `validateP2shParams`, via a shared `validateRawTxHex()` (max 400,000 chars, even-length hex) that rejects malformed inputs with a precise `-32602` error before they reach the coin node.

### Fixed
- Fix single-chunk `P2WSH` reveals being rejected by Litecoin Core (`tx-size-small`): `CryptoNetworks` now carries a per-network `minStandardTxNonWitnessSize`, and the reveal builder pads stripped size over that floor with a small payment output when needed; `estimateSpendingP2wshTx()` reflects the padded size.
- Throw a `RangeError` at construction time when explicit `encoding: 'OP_RETURN'` is forced with a compiled payload larger than 76 bytes, instead of silently emitting a multi-OP_RETURN PSBT that always fails at broadcast.
- Fix `validateCombinedDataLength` undercounting dual-push payloads: a new `compiledPushSize()` helper models per-push `OP_PUSHDATA2` overhead so the pre-check compares the actual compiled size against `MAX_COMPILED_ACTION_DATA_LENGTH` (8192).
- Correct the Litecoin dust threshold from `546` to `5460` litoshis in `CryptoNetworks.js` so the encoder no longer emits outputs the LTC node rejects as dust.
- Run tracker-fetched UTXOs through `validateUtxoArray` immediately after the fetch in `XChainEncoder.js`, and tighten `UtxoTracker.js`'s response validator to enforce 64-char hex `txid` and default `confirmations` to `0` when `null`.
- Lower `MAX_DATA_BYTES` from `8192` to `8189` in `validator.js` so raw payloads of 8190-8192 bytes (which compile to > 8192 with the `OP_PUSHDATA2` prefix) are rejected up front with a clear message.
- Fix `MULTISIGN` change calculation: the data output's value is now counted toward the running output total before computing change, preventing total outputs from exceeding total inputs.
- Fix `MULTISIGN` data outputs being sized at the flat P2PKH dust floor (`546` sat): output value is now derived from the actual script length using Bitcoin Core's dust formula, matching the node's relay threshold.
- Fix three independent `P2WSH` encoding defects: cap chunk size at 476 bytes (the `MAX_SCRIPT_ELEMENT_SIZE` limit), count data output values toward the output total before computing change, and size each data output to fund its share of the reveal-tx fee via a new `estimateSpendingP2wshTx()` helper.
- Require `scriptPubKey` in `UtxoTracker.js`'s `getUtxosFromAddress()` response validator so a missing field is caught at the response boundary instead of crashing deep in PSBT construction.

### Changed
- `getUtxosFromAddress()` pre-flight sync guard now consumes the tracker's own `synced` boolean instead of re-deriving it locally, removing the stale `SYNCED_THRESHOLD = 3` constant.
- Pin `bitcoinjs-lib` 6.1.7, `ecpair` 2.1.0, `bip32` 4.0.0, and `tiny-secp256k1` 2.2.4 to exact versions in `package.json` so every install resolves a byte-identical dependency tree.
- Replace `cross-fetch` with `axios` (`^1.16.0`) in `BlockchainConnector` and `UtxoTracker`, aligning the encoder with the platform-wide HTTP client convention.
- Commit `package-lock.json` and build the Docker image with `npm ci` so container images always resolve the exact tested dependency tree.
- Upgrade `express-rate-limit` from `^7.0.0` to `^8.5.2` and adopt v8 option names (`windowMs`, `limit`, `standardHeaders`, `legacyHeaders`) in `src/api.js`.
- Rename the rate-limit env var from `RATE_LIMIT_RPM` to `ENCODER_RATE_LIMIT_RPM` (default 60 req/min unchanged); operators must migrate the old name.
- Raise the `bitcoinjs-lib` floor from `^6.1.5` to `^6.1.7` to match the decoder, UTXO-tracker, and SDK; regenerate the lockfile.

### Tests
- Add a `createTransaction` regression test asserting `MULTISIGN` total outputs never exceed total inputs, and update existing structure tests to identify data outputs by script shape rather than exact dust value.
- Add a `createTransaction` regression test covering a short final `MULTISIGN` chunk (compiled payload 88 bytes, chunks 60+28) to exercise the previously-failing path through `p2ms()` construction.

## [1.6.9] - 2026-05-29

### Added
- `getUtxosFromAddress()` now calls `get_sync_status` before fetching UTXOs and raises a clear error when the tracker lags the chain tip by more than 3 blocks or has not yet indexed any blocks.

## [1.6.8] - 2026-05-29

### Fixed
- All coin-node RPC calls (`BlockchainConnector`) and UTXO-tracker queries (`UtxoTracker.getUtxosFromAddress`) now abort after a 15-second timeout via `AbortController`, replacing the previous no-timeout behavior.

## [1.6.7] - 2026-05-29

### Fixed
- `getFirstBlock()` now returns correct ingest floors for Litecoin and Dogecoin networks (and corrects `bitcoin-testnet` from `0` to `100,000`) so the encoder and decoder agree on the first block scanned per network.

## [1.6.6] - 2026-05-29

### Changed
- `getFirstBlock()` for `bitcoin-mainnet` now returns `900000` instead of `844000`, matching the decoder's mainnet ingest floor.

## [1.6.5] - 2026-05-28

### Fixed
- Align the encoder's max payload limits with the decoder's hard ingest ceiling: the inner guard now rejects compiled sizes above 8,195 bytes and `MAX_DATA_BYTES` is lowered from 65,536 to 8,192, preventing payloads the decoder silently drops from being encoded and broadcast.

## [1.6.4] - 2026-05-28

### Fixed
- Multi-chunk `MULTISIGN` encoding now zero-pads every chunk to a full 64-byte slot before splitting across pubkey halves, fixing rejections (`Expected property 'pubkeys.1' of type isPoint`) on payloads whose compiled size is not a multiple of 60.

## [1.6.3] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (`qs.stringify` DoS on null/undefined entries in comma-format arrays with `encodeValuesOnly`).

## [1.6.2] - 2026-04-07

### Added
- `sendRawTransaction(txHex)` method on `BlockchainConnector`: broadcasts signed transactions to the coin node via `sendrawtransaction` JSON-RPC
- `broadcast_tx` JSON-RPC method in `api.js`: exposes transaction broadcasting via the encoder's RPC interface
- `get_utxos` JSON-RPC method in `api.js`: exposes UTXO queries by proxying to the xchain-utxo-tracker service

## [1.6.1] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [1.6.0] - 2026-04-06

### Added
- `feeQuote` parameter for `create_tx`: automatically adds a protocol fee output to the PSBT when provided with `{ address, amount }` from the hub's `getfeequote` endpoint
- `validateFeeQuote()` in validator.js, validates address (string, max 100 chars) and amount (positive integer, max 2.1T satoshis)

## [1.5.1] - 2026-04-05

### Changed
- Moved Stryker mutation configs (`stryker.conf.json`, `stryker.conf.quick.json`) from project root into `test/mutation/`
- Updated `mutate` and `mutate:quick` npm scripts to reference new config paths

## [1.5.0] - 2026-04-03

### Added
- Regression test suite (`test/regression/`) with 196 tests across 8 files covering all critical encoder paths
- `reg-01-encoding-types.test.js`: all 4 encoding types (OP_RETURN, P2SH, P2WSH, MULTISIGN) produce valid PSBTs
- `reg-02-obfuscation.test.js`: AES-128-CTR round-trip, key derivation, TXID sensitivity, P2SH/P2WSH markers
- `reg-03-fee-utxo.test.js`: UTXO selection/sort, deduplication, fee calculation, dust floor, change output, tracker fallback
- `reg-04-validator.test.js`: dedicated coverage for all validate* functions in src/validator.js (fills identified coverage gap)
- `reg-05-multi-chain.test.js`: Bitcoin, Litecoin, Dogecoin network configs, dust thresholds, P2WSH segwit restriction
- `reg-06-p2sh-p2wsh-sequence.test.js`: tx1->tx2 chaining integrity for P2SH and P2WSH encoding
- `reg-07-action-pipeline.test.js`: SEND, ISSUE, MULTISEND, ORDER, BROADCAST, FILE, BATCH, rawData, special characters
- `reg-08-api-contract.test.js`: validateAll->createTransaction parameter flow, error classification, PSBT serialization
- `npm run test:regression` script
- Regression testing strategy report at `reports/XCHAIN_ENCODER_REGRESSION_TESTING_PLAN.md`

## [1.4.0] - 2026-04-03

### Added
- Mutation testing with StrykerJS v8 targeting XChainEncoder.js, validator.js, TxSizeEstimator.js, and CryptoNetworks.js
- `stryker.conf.json`: full mutation config running unit/integration/boundary/chaos tests against 896 mutants across 4 source files
- `stryker.conf.quick.json`: incremental config for PR-level checks (XChainEncoder.js only, ~47s)
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
- `bench.js`: standalone benchmark harness with CLI flags (`--full`, `--scenario`, `--json`, `--warmup`, `--iters`) measuring per-encoding throughput, latency percentiles, memory, and GC pauses
- `soak.js`: sustained-duration leak and latency drift detector with 10-second window summaries and automatic warnings
- k6 API load test scripts: `sustained.js` (constant 100 req/sec), `spike.js` (burst to 500 req/sec), `concurrent.js` (ramp 1-100 VUs)
- Metrics helpers: Histogram (nanosecond-precision), MemoryTracker, GcTracker, EldTracker, ASCII report formatter, JSON report writer
- Pre-built fixture library reusing existing utxoFactory and actionFactory test helpers
- `npm run bench`, `bench:full`, `bench:soak`, `bench:k6` scripts
- Performance testing plan report at `reports/XCHAIN_ENCODER_PERFORMANCE_TESTING_PLAN.md`

## [1.1.0] - 2026-04-03

### Added
- `src/validator.js`: centralized input validation module with 14 validators for all `createTransaction` parameters (types, ranges, formats, array limits)
- API key authentication middleware (opt-in via `API_KEY` env var, checks `x-api-key` header)
- Rate limiting via `express-rate-limit` (configurable via `RATE_LIMIT_RPM`, default 60 req/min)
- CORS restriction (configurable via `CORS_ORIGIN` env var, default disabled)
- Request body size limit (1 MB) on JSON-RPC endpoint
- Payload size hard limit (64 KB) on combined `data` + `rawData`
- P2WSH encoding blocked on Dogecoin networks (no bech32 support)
- `supportsSegwit: false` flag on all Dogecoin network configs in CryptoNetworks
- P2WSH `p2shTx.outs` bounds check before accessing output by index
- `changeSatoshis` NaN guard, throws RangeError if fee arithmetic produces non-finite result
- Security audit plan report at `reports/XCHAIN_ENCODER_SECURITY_AUDIT_PLAN.md`

### Fixed
- `customOutputs` value parsing now uses `parseInt(value, 10)` with NaN and negative guards, prevents silent NaN propagation that could burn all change as miner fees
- UTXO value parsing now uses `parseInt(value, 10)` with NaN guard, prevents hex string interpretation and silent arithmetic corruption
- Explicit `fee` parameter now validated as non-negative integer, previously accepted NaN, negative, or non-numeric values
- `prepareData()` now throws TypeError for unknown encoding instead of returning null (which caused opaque TypeError downstream)
- `CryptoNetworks.getBitcoinJsNetwork()` now throws TypeError for unknown network names instead of returning undefined (which crashed the process on startup)
- Error sanitization in API layer, TypeError/RangeError messages forwarded, all other errors return generic "Internal encoder error" to prevent information leakage
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
- MULTISIGN_SIZE reduced from 71 to 69, previous value allowed chunk sizes that produced oversized fake pubkeys (>33 bytes), causing `p2ms()` to reject data payloads of 60+ compiled bytes
- PW2SH_SIZE reduced from 10000 to 3615, previous value exceeded bitcoinjs-lib's 3600-byte redeem script limit, causing all P2WSH payloads over ~3568 chars to throw
- TxSizeEstimator.estimateInputSize() now returns 350 (conservative fallback) instead of null when UTXO data is missing, null silently coerced to 0 in JavaScript arithmetic, causing fee underestimation

## [0.1.4] - 2026-04-02

### Added
- End-to-end test suite (157 tests) validating the full encoding pipeline from ACTION configuration input to PSBT output
- Test categories: full ACTION-to-PSBT pipeline (all 19+ ACTION types, all SEND versions v0-v3), two-transaction P2SH/P2WSH orchestration with data fidelity verification, encoding type boundaries, obfuscation integrity, UTXO/fee/change integration, multi-chain validation (BTC/DOGE/LTC), complex parameter edge cases (unicode, zero amounts, big numbers, custom dust), error rejection, and round-trip encoder-decoder consistency
- Tier 2 API layer tests (JSON-RPC endpoint validation, CORS, concurrency) that auto-skip when server is not running
- E2E testing plan report at `reports/XCHAIN_ENCODER_E2E_TESTING_PLAN.md`

## [0.1.3] - 2026-04-02

### Added
- Smoke test suite (52 tests) for fast health-check validation of all core building blocks: module loading, encoder instantiation, CryptoNetworks integrity, PSBT creation, prepareData (all 4 encoding types), obfuscation round-trip, TxSizeEstimator, Segwit UTXO detection, dataToPubkey, and API server startup
- `npm run smoke-test` script, runs in under 1 second with zero infrastructure dependencies
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
