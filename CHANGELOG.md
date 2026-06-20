# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.10] - 2026-06-20

### Added
- `src/validator.js`, `src/api.js` — raw-transaction hex inputs are now shape- and length-validated before any expensive work. `broadcast_tx` previously checked only truthiness of `tx_hex` and forwarded it verbatim to the coin node's `sendrawtransaction` (bounded by the 1 MB body limit and the rate limiter, so not exploitable — but a malformed payload cost a node round-trip and surfaced an opaque node parse error), and `validateP2shParams` required `p2shHex` be non-empty but applied no length cap before it reached `Transaction.fromHex`/`Buffer.from`. A new `validateRawTxHex()` (shared `MAX_RAW_TX_HEX_LENGTH = 400,000` chars ≈ a 200 KB transaction, double the ~100 KB standard-tx ceiling, plus an even-length-hex shape check) now guards `broadcast_tx` with a precise `-32602` reason, and `validateP2shParams` enforces the same shape + cap on `p2shHex`. Defensive hardening only — both paths were already bounded by the body-parser limit; this sheds garbage early and names the rejection. Unit tests cover shape rejections (non-string/empty/odd-length/non-hex), the over-cap rejection, and at-cap acceptance for both validators.

### Fixed
- `src/XChainEncoder.js`, `src/CryptoNetworks.js` — a single-chunk `P2WSH` reveal transaction is no longer unbroadcastable on Litecoin. When a `P2WSH`-encoded ACTION's compiled payload fits in one 476-byte chunk, the reveal (spending) transaction is just one input plus the OP_RETURN marker — 71 stripped (non-witness) bytes. Bitcoin Core relays it (`MIN_STANDARD_TX_NONWITNESS_SIZE = 65`), but Litecoin Core rejects it as `tx-size-small` (its floor is ~85 bytes) because the payload lives in the witness and does not count toward the stripped size; the encoder emitted a structurally valid PSBT that silently failed at broadcast on every Litecoin network. `CryptoNetworks` now carries a per-network `minStandardTxNonWitnessSize` (65 for Bitcoin, 85 for Litecoin), the `P2WSH` funding output is over-funded by one dust when its reveal would land below that floor, and the reveal builder pads the stripped size over the floor with one small payment output back to the caller's own address (a second OP_RETURN would be non-standard `multi-op-return`). `estimateSpendingP2wshTx()` reflects the padded size so the embedded fee stays accurate. Bitcoin reveals are unchanged (71 ≥ 65, no padding). Regression cases for both the minimum (compiled 75) and maximum (compiled 476) single-chunk sizes assert the reveal clears the Litecoin floor, with a Bitcoin control proving the padding is chain-specific.
- `src/XChainEncoder.js` — explicit `encoding: 'OP_RETURN'` no longer builds a transaction that can never be broadcast. A transaction may carry at most one OP_RETURN output: Bitcoin Core (≥v0.12) rejects multi-OP_RETURN transactions as non-standard (`multi-op-return`) at relay. When a caller forced OP_RETURN with a compiled payload larger than one 76-byte chunk, `prepareData` silently split it across several OP_RETURN outputs, producing a structurally valid PSBT that always failed at `broadcast_tx` — consuming the fee UTXOs with no construction-time error. The auto-selection path already avoided this by falling back to P2SH past 76 bytes; the explicit path now mirrors that guard and throws a `RangeError` (`OP_RETURN encoding requires compiled payload <= 76 bytes…; Use P2SH for larger payloads.`) up front. Callers needing larger payloads should use P2SH (or the auto path, which selects it automatically). Unit, integration, boundary, regression, fuzz, smoke, and e2e expectations that previously asserted multi-chunk OP_RETURN success now assert the rejection.
- `src/validator.js` — the combined-payload pre-check undercounted dual-push payloads. `validateCombinedDataLength` summed the raw byte lengths of `data` and `rawData` against a single 8189-byte ceiling, which is correct only when one push is built. When both fields are present, `prepareData` compiles them as two separate script pushes (`bitcoin.script.compile([utf8Buffer, rawDataBuffer])`), so each push ≥ 256 bytes carries its own 3-byte `OP_PUSHDATA2` prefix — 6 bytes of overhead, not 3. A payload of `data = 4094` + `rawData = 4095` bytes (raw sum 8189) passed the pre-check but compiled to 8195 bytes, over the 8192-byte compiled ceiling, and then threw an opaque `RangeError` deep inside `createTransaction`. The check now models per-push overhead via a new `compiledPushSize()` helper and compares the *compiled* size against `MAX_COMPILED_ACTION_DATA_LENGTH` (8192) directly, so oversized dual-push payloads are rejected up front with a clear `Combined compiled payload (N bytes) exceeds maximum (8192)` message. Single-push callers are unaffected — an 8189-byte single payload still compiles to exactly 8192 and passes. No on-chain behavior changes; the downstream compiled-size check remains the authoritative guard. Unit tests cover the dual-push boundary (4093+4093 accepted at the 8192 ceiling, 4094+4094 and the 4094+4095 undercount case rejected) and the preserved single-push ceiling.
- `src/CryptoNetworks.js` — corrected the Litecoin dust threshold from `546` to `5460` litoshis for all three `litecoin-*` networks. Litecoin Core's dust relay fee is 10× Bitcoin's (`DUST_RELAY_TX_FEE = 30000` lit/kvB), so the effective dust floor for a standard output is 5460 litoshis, not Bitcoin's 546. With the old value the encoder could emit fee-destination and change outputs in the 546–5459 range, which the LTC node rejects outright with `{"code":-26,"message":"dust"}` — the transaction never reached the mempool, so an action sequence that confirms on BTC/DOGE silently failed on LTC. The constant flows through `XChainEncoder.dustAmount` into the fee-output floor, the change threshold, and bare-multisig dust sizing. Unit and integration test expectations updated to the per-chain values; the regression suite already pinned 5460 as the correct LTC floor.
- Tracker-fetched UTXOs bypassed the validation that caller-supplied UTXOs receive, yet both paths feed into the same PSBT construction code. When the encoder auto-fetched UTXOs from the tracker (the normal path once the caller's UTXO cache is exhausted), the response skipped `validateUtxoArray` entirely — only a loose `typeof` check guarded `txid`/`vout`/`value`. A malformed `txid` (e.g. the tracker's short zero-hash sentinel, 16 hex chars) or a `null` `confirmations` would pass through and then throw an opaque error deep inside `bitcoinjs-lib`'s `psbt.addInput()` at construction time, breaking the whole action. `XChainEncoder.js` now runs the tracker result through `validateUtxoArray` immediately after the fetch (enforcing 64-char hex `txid`, integer `vout`/`value`, non-empty `scriptPubKey`, and a `confirmations` default), so a malformed tracker output is rejected at the seam with a clear message. `src/UtxoTracker.js`'s `getUtxosFromAddress()` response validator was correspondingly tightened to reject any `txid` that is not a 64-character hex string and to default `confirmations` to `0` when `null`, closing the gap at the source as well.
- `src/validator.js` — the raw-payload pre-check `MAX_DATA_BYTES` was `8192`, but a raw data string of N bytes (N ≥ 256) compiles to N + 3 once the OP_PUSHDATA2 prefix is added, so the largest raw payload that still fits the 8192-byte compiled on-chain ceiling is 8189. Raw payloads of 8190–8192 bytes passed the pre-check and then threw a confusing `RangeError: Payload too large: compiled size 8193 bytes exceeds maximum 8192 bytes` from inside `createTransaction`. `MAX_DATA_BYTES` is now `8189`, so such payloads are rejected up front with the clear `Combined data payload (N bytes) exceeds maximum (8189)` message. No round-trip data is affected — over-limit payloads were already rejected before any transaction was built; this only improves the error surfaced to callers. The compiled ceiling `MAX_COMPILED_ACTION_DATA_LENGTH` (8192) is unchanged.
- `MULTISIGN` encoding built an invalid transaction at any relay-valid dust level. The bare-multisig data output carries real value, but that value was never added to the running output total before change was computed, so change was over-credited by exactly the data-output amount — whenever that amount met or exceeded the fee, total outputs exceeded total inputs and the transaction was rejected (`bitcoinjs-lib`: "Outputs are spending more than Inputs"; the network would reject it as invalid). The output value is now counted toward the output total before the change calculation, mirroring the custom-output path.
- `MULTISIGN` data outputs were sized with the flat P2PKH dust floor (`546` sat), which is below the node's relay dust threshold for a larger bare-multisig script, so broadcasts were rejected with `{"code":-26,"message":"dust"}`. The output value is now sized from the actual script length using Bitcoin Core's dust formula (`(output_bytes + 148) * 3` sat), ≈786 sat for a standard 1-of-3 compressed-key script, so the node accepts it. Callers can still raise the floor via `dust`.
- `P2WSH` encoding produced transactions the network rejected, for three independent reasons, none of which surfaced until a large payload was driven through a live encode→broadcast→reveal round-trip:
  - The per-chunk witness-script size was capped at `3571` bytes (`PW2SH_SIZE = 3615`), but each data chunk is pushed as a *single* script element, which consensus bounds at `MAX_SCRIPT_ELEMENT_SIZE` (520 bytes) — the same limit that already caps the P2SH chunk. A larger chunk built a witness script the node rejected at spend time with `mandatory-script-verify-flag-failed (Push value size limit exceeded)`. The chunk size is now `520 - 44 = 476` bytes, identical to P2SH; large payloads simply fan out across more outputs.
  - The data outputs in the first (commit) transaction were not added to the running output total before change was computed, so change was over-credited by exactly the data-output amount and total outputs exceeded total inputs (`bitcoinjs-lib`: "Outputs are spending more than Inputs"). The output value is now counted toward the output total, mirroring the P2SH and `MULTISIGN` paths.
  - Each data output carried a flat dust value (`546` sat), which left the multi-input reveal transaction below the node's minimum relay fee (observed `min relay fee not met, 1638 < 2228`). Each output is now sized to fund its share of the reveal-tx fee via a new `estimateSpendingP2wshTx()` helper that uses witness-discounted (÷4) sizing — analogous to the existing `estimateSpendingP2shTx()` but accounting for P2WSH data living in the segwit witness rather than the scriptSig.
- `src/UtxoTracker.js` — the UTXO-tracker response validator in `getUtxosFromAddress()` now also requires each returned UTXO to carry a non-empty string `scriptPubKey`, mirroring the caller-supplied-UTXO validator in `validator.js`. Previously only `txid`, `vout`, and `value` were checked; a tracker that omitted or renamed `scriptPubKey` would pass validation and then crash deep in PSBT construction with an opaque `TypeError` from `Buffer.from(undefined, 'hex')`. The missing field is now reported as a clear contract violation at the response boundary.

### Changed
- `src/UtxoTracker.js` — the pre-flight sync guard in `getUtxosFromAddress()` now trusts the tracker's own sync verdict instead of re-deriving it locally. The tracker's `get_sync_status` response now returns a `synced` boolean (computed against its authoritative threshold), so the encoder consumes `syncStatus.synced` and the local `SYNCED_THRESHOLD = 3` constant — which only mirrored the tracker's value — has been removed. This eliminates a silent-drift risk: if the tracker ever retunes its threshold (e.g. for slower-block-time chains), the encoder's guard tracks the change automatically rather than continuing to apply a stale copy. The null-lag case (tracker has indexed no blocks) still raises its distinct "has not indexed any blocks yet" error before the synced check.
- `package.json` — pinned `bitcoinjs-lib` 6.1.7, `ecpair` 2.1.0, `bip32` 4.0.0, `tiny-secp256k1` 2.2.4 to exact versions (dropped the `^` caret ranges) so every install resolves a byte-identical dependency tree across operator nodes, matching the versions already frozen in `package-lock.json`. No source changes.
- Swapped the HTTP client from `cross-fetch` to `axios` (`^1.16.0`), the client already used by every other platform service that makes HTTP calls (decoder, hub, explorer, UTXO-tracker, e2e). `BlockchainConnector` and `UtxoTracker` now issue their JSON-RPC requests via `axios.post`, using axios's built-in `auth` (HTTP Basic) and per-request `timeout` options in place of the hand-built `Authorization` header and `AbortController` timer. Behavior is unchanged: the same request timeouts apply (30s for coin-node RPC via `NODE_RPC_TIMEOUT`, 15s for the UTXO tracker), and `sendRawTransaction` still reads the node's JSON-RPC error body on an HTTP 500 (now off `error.response.data`) so a rejected broadcast surfaces the node's actual reason rather than a bare status code. Removes the encoder's one-off HTTP dependency and aligns it with the platform baseline.
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo (previously git-ignored) and the Docker image is built with `npm ci` instead of `npm install`. `npm ci` installs the exact dependency tree recorded in the lockfile and fails the build if the lockfile is missing or out of sync with `package.json`, so a container image can no longer silently pick up newer transitive dependency versions than were tested.
- Upgraded `express-rate-limit` from `^7.0.0` to `^8.5.2`, aligning it with the version used by the other platform API services so rate-limiter configuration can be shared safely across services. The limiter config in `src/api.js` now uses v8's canonical option names (`windowMs`, `limit`, `standardHeaders`, `legacyHeaders`, `message`) — the per-window request cap was renamed from the deprecated `max` alias to `limit` (`max` still works as a backward-compatible alias but is slated for removal in a future major), so runtime behavior is unchanged; the v8 breaking changes (`keyGenerator` signature, removal of `onLimitReached`, and the `handler` callback signature) do not affect any code here.
- Renamed the API rate-limit environment variable from `RATE_LIMIT_RPM` to `ENCODER_RATE_LIMIT_RPM` (default `60` requests/minute per IP, unchanged), adopting the per-service `<SERVICE>_RATE_LIMIT_RPM` naming convention so each containerized service has an unambiguous, independently named rate-limit knob. **Operators who set `RATE_LIMIT_RPM` must migrate to `ENCODER_RATE_LIMIT_RPM`** — the old name is no longer read.
- Raised the `bitcoinjs-lib` dependency floor from `^6.1.5` to `^6.1.7`, matching the version already declared by the decoder, UTXO-tracker, and SDK services. All of these resolved to `6.1.7` at runtime, but the encoder's lower floor meant an isolated `package-lock.json` regeneration could pick up an older `6.1.x` patch than the decoder side — a real divergence risk for a library that owns PSBT and script serialization shared across the encode/decode round-trip. The lockfile is regenerated; no resolved versions or source code change.

### Tests
- Added a `createTransaction` regression test asserting that a `MULTISIGN` transaction's total outputs never exceed its total inputs (large `dust`, tiny fee — the exact condition that previously produced an invalid tx). Updated the existing `MULTISIGN` structure tests to identify the data output by its script shape (a bare `OP_CHECKMULTISIG` script) rather than by an exact dust value, since the output is now sized to the relay-fee dust floor.
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
