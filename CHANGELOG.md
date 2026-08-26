# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-08-25

### Changed
- Updated the BTC mainnet validator reward pool address.
- Resynced the testnet genesis registry (BTC, LTC, and DOGE first-block heights and pins) so the public testnet starts effectively empty.

### Fixed
- The fee rate chosen for a caller who supplies none is capped on test chains, where the node has no fee market to estimate from and returns a fallback that prices an ordinary action above the balance funding it.
- `feeQuote` validation now rejects an array, which previously passed the object-shape check and failed later with a misleading address error instead of a shape error.
- Cumulative log-shipper totals (`log_lines_shipped_total`, `log_lines_dropped_total`, `log_ship_failures_total`) are now published as counters instead of gauges, so rate() queries over them behave correctly.

## [0.10.0] - 2026-08-18

### Fixed
- A multi-page UTXO fetch refuses to merge pages that came from different tracker snapshots, so a rollback between pages can no longer leave orphaned outputs behind a healthy-looking freshness check.
- The key-bearing input txid is lowercased at ingest, so a mixed-case caller no longer surfaces a bogus input-selection race.
- A `rawData` payload with no data is reported back to the fee-payer as a warning, because it confirms and pays a fee without ever indexing as an action.
- The compiled size ceiling is measured after compression.
- The runtime image is pinned rather than floating.
- Code-review round fixes across the encode path (5 files).

### Security
- Raised the brace-expansion and js-yaml dependency floors and the advisory guards that pin them.

## [0.9.0] - 2026-08-14

First release of the XChain Platform release train. Every component in the train
now shares one platform version, so "XChain 0.9.0" names an exact, reproducible
set of software rather than a rough era.

### Changed
- Adopted the platform version stream. This component moves from `1.6.12` to
  `0.9.0`. **The number is lower but the release is newer**: the platform stream
  starts at 0.9.0 for the testnet series, and 1.0.0 is reserved for mainnet.

<!-- ------------------------------------------------------------------------
     Versions BELOW this line are this component's own legacy stream, from
     before the release train. They are kept for history and are NOT comparable
     to the platform versions above: a higher legacy number is an older release.
     ------------------------------------------------------------------------ -->

## [1.6.12] - 2026-08-13

### Fixed
- `npm run ci` now runs the roundtrip conformance suite, so an encoder that stops producing the golden fixture bytes fails CI.
- `CORS_ORIGIN` accepts a comma-separated allowlist matched per-origin instead of echoing a multi-value header no browser accepts.
- The explicit `OP_RETURN` 76-byte ceiling is enforced pre-compile as a `-32602` invalid-params error.
- Satoshi and fee money fields are parsed as exact integers, so `"1e8"`, `"100.5"` and `"5abc"` are rejected instead of truncated.
- An omitted `data` param defaults to `''`, so a data-omitted request builds a payment-only tx instead of crashing.
- `utxos[].scriptPubKey` is validated as bounded even-length hex instead of silently truncating through `Buffer.from(x, 'hex')`.
- The obfuscation key binds to `ins[0]` by construction and fails closed when selection races a reservation.
- P2WSH witness-stack items are sized with compactSize varint framing instead of the script-push formula.

## [1.6.11] - 2026-07-16

### Fixed
- `rbf` and `unconfirmed` are validated as strict booleans, so the string `"false"` can no longer flip UTXO-selection policy.
- `health()` and `GET /status` apply `create_tx`'s tracker-lag gate, so serve-readiness matches what `create_tx` accepts.

## [1.6.10] - 2026-06-20

### Added
- `broadcast_tx` and `p2shHex` validate raw transaction hex shape and length up front with a precise `-32602` error.

### Fixed
- Single-chunk P2WSH reveals are padded over each chain's stripped-size relay floor, fixing Litecoin `tx-size-small` rejections.
- Explicit `encoding: 'OP_RETURN'` with a payload over 76 bytes throws instead of emitting an unbroadcastable multi-OP_RETURN PSBT.
- `validateCombinedDataLength` models per-push `OP_PUSHDATA2` overhead, so dual-push payloads are measured against the real compiled size.
- The Litecoin dust threshold is corrected from 546 to 5460 litoshis.
- Tracker-fetched UTXOs are validated on arrival, and the tracker response validator enforces 64-char hex txids.
- `MAX_DATA_BYTES` is lowered to 8189 so payloads that compile past the 8192-byte ceiling are rejected up front.
- MULTISIGN change math counts the data output's value, so total outputs no longer exceed total inputs.
- MULTISIGN data outputs are sized from the actual script length rather than a flat P2PKH dust floor.
- P2WSH chunk size is capped at 476 bytes, data output values count toward the output total, and each output funds its share of the reveal fee.
- The tracker response validator requires `scriptPubKey`, catching a missing field at the boundary instead of deep in PSBT construction.

### Changed
- The tracker sync pre-flight consumes the tracker's own `synced` boolean instead of re-deriving a local threshold.
- `bitcoinjs-lib`, `ecpair`, `bip32` and `tiny-secp256k1` are pinned to exact versions.
- `BlockchainConnector` and `UtxoTracker` use `axios` instead of `cross-fetch`.
- `package-lock.json` is committed and Docker images build with `npm ci`.
- `express-rate-limit` is upgraded to v8 and its v8 option names are adopted.
- The rate-limit env var is renamed from `RATE_LIMIT_RPM` to `ENCODER_RATE_LIMIT_RPM`; operators must migrate the old name.

### Tests
- Added regression coverage for MULTISIGN output totals and for a short final MULTISIGN chunk.

## [1.6.9] - 2026-05-29

### Added
- `getUtxosFromAddress()` checks tracker sync status first and errors clearly when the tracker lags the chain tip.

## [1.6.8] - 2026-05-29

### Fixed
- Coin-node RPC calls and UTXO-tracker queries abort after a 15-second timeout instead of hanging indefinitely.

## [1.6.7] - 2026-05-29

### Fixed
- `getFirstBlock()` returns the correct ingest floor for every Litecoin, Dogecoin and Bitcoin network.

## [1.6.6] - 2026-05-29

### Changed
- `getFirstBlock()` for `bitcoin-mainnet` returns 900000, matching the decoder's mainnet ingest floor.

## [1.6.5] - 2026-05-28

### Fixed
- Max payload limits are aligned with the decoder's ingest ceiling so payloads the decoder would drop can no longer be broadcast.

## [1.6.4] - 2026-05-28

### Fixed
- Multi-chunk MULTISIGN zero-pads every chunk to a full 64-byte slot, fixing `isPoint` rejections on payloads not a multiple of 60.

## [1.6.3] - 2026-05-28

### Security
- Pinned `qs` to `^6.15.2`, remediating GHSA-q8mj-m7cp-5q26.

## [1.6.2] - 2026-04-07

### Added
- `sendRawTransaction(txHex)` on `BlockchainConnector` broadcasts signed transactions to the coin node.
- `broadcast_tx` JSON-RPC method exposes transaction broadcasting.
- `get_utxos` JSON-RPC method proxies UTXO queries to the UTXO tracker.

## [1.6.1] - 2026-04-06

### Changed
- Moved the coverage badge to its own line in README.md.

## [1.6.0] - 2026-04-06

### Added
- `feeQuote` on `create_tx` adds a protocol fee output to the PSBT when given `{ address, amount }`.
- `validateFeeQuote()` validates the fee-quote address and amount.

## [1.5.1] - 2026-04-05

### Changed
- Moved the Stryker mutation configs into `test/mutation/` and updated the npm scripts.

## [1.5.0] - 2026-04-03

### Added
- Regression test suite covering all critical encoder paths, with an `npm run test:regression` script.

## [1.4.0] - 2026-04-03

### Added
- Mutation testing with StrykerJS, with full and incremental configs and `mutate` / `mutate:quick` scripts.

## [1.3.0] - 2026-04-03

### Added
- Chaos test suite covering dependency failures, input corruption, library monkey-patching, arithmetic edges and resource exhaustion.

## [1.2.0] - 2026-04-03

### Added
- Performance suite with a benchmark harness, a soak runner, k6 load scripts and metrics helpers.

## [1.1.0] - 2026-04-03

### Added
- `src/validator.js` centralizes input validation for every `createTransaction` parameter.
- Optional API-key authentication via the `API_KEY` env var and an `x-api-key` header.
- Per-IP rate limiting, configurable CORS, a request body size limit and a combined payload size limit.
- P2WSH encoding is blocked on Dogecoin, which has no segwit support.
- Bounds and NaN guards on P2WSH output indexing and change arithmetic.

### Fixed
- `customOutputs` and UTXO values are parsed with NaN and negative guards, preventing silent fee burn.
- The explicit `fee` parameter is validated as a non-negative integer.
- `prepareData()` throws for an unknown encoding instead of returning null.
- `getBitcoinJsNetwork()` throws for an unknown network name instead of crashing at startup.
- Unexpected errors return a generic message so internals cannot leak through the API.
- The change-address error message no longer reveals the exact wallet balance.

### Changed
- All API parameters are validated via `validator.validateAll()` before reaching the encoder.

## [1.0.0] - 2026-04-02

### Changed
- Bumped version to 1.0.0.

## [0.1.5] - 2026-04-02

### Added
- Boundary test suite verifying encoder behavior at exact parameter limits, with an `npm run test:boundary` script.

### Fixed
- `MULTISIGN_SIZE` lowered from 71 to 69, which had produced oversized fake pubkeys that `p2ms()` rejected.
- `PW2SH_SIZE` lowered from 10000 to 3615 so P2WSH payloads no longer exceed the redeem-script limit.
- `estimateInputSize()` returns a conservative 350 instead of null when UTXO data is missing, preventing fee underestimation.

## [0.1.4] - 2026-04-02

### Added
- End-to-end suite validating the full pipeline from ACTION input to PSBT output across every encoding and chain.
- API-layer tests that auto-skip when no server is running.

## [0.1.3] - 2026-04-02

### Added
- Smoke test suite for fast health-check validation of every core building block, via `npm run smoke-test`.

## [0.1.2] - 2026-04-02

### Added
- Integration suite covering payload fidelity, encoding types, obfuscation, fees, custom outputs and multi-chain behavior.
- Shared test helpers for deobfuscation and for UTXO and ACTION fixtures.

## [0.1.1] - 2026-04-02

### Added
- Unit test suite covering every encoder module, with an `npm run test:unit` script.

## [0.1.0] - 2026-04-02

### Added
- `customOutputs` support in `createTransaction` adds arbitrary payment outputs alongside OP_RETURN data.
