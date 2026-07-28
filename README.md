<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform Encoder

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.10-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-769%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20boundary%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20regression%20%7C%20performance%20%7C%20smoke-brightgreen" alt="Coverage">
</p>

PSBT encoding service for the XChain Platform. Takes an ACTION string, a set of UTXOs, and a public key, and returns an unsigned Partially Signed Bitcoin Transaction (PSBT) ready for the caller to sign and broadcast. The encoder is fully stateless: no database, no persistent connections, every call is independent.

## Features

- **Four encoding formats**: OP_RETURN (76B), P2SH (476B), P2WSH (476B), and multisig (~61B/key); auto-selected by payload size
- **AES-128-CTR obfuscation**: derives key and IV from the first input's txid; `XCHN` magic prefix on all payloads
- **Two-transaction P2SH/P2WSH**: automatic tx1 (fund) -> tx2 (spend/reveal) orchestration with marker OP_RETURN
- **UTXO selection**: largest-first selection, duplicate removal, optional unconfirmed filtering, automatic change output
- **Fee estimation**: byte-accurate transaction size estimation per format via `TxSizeEstimator`; dust floor enforcement
- **Fee rate caps**: caller-supplied `fee`/`feePerKb` is capped at `MAX_FEE_RATE_MULTIPLIER` x the node's own fee estimate (default 100x), so a hostile or buggy request cannot drain inputs into miner fee; `MAX_FEE_RATE_KB` adds an optional absolute cap
- **Input validation**: centralized parameter validation (`validator.js`) with typed errors for all 15 `createTransaction` parameters
- **Multi-chain support**: Bitcoin, Litecoin, and Dogecoin on mainnet, testnet, and regtest (9 network configs)
- **Replace-By-Fee**: optional RBF signaling via sequence number
- **Custom outputs**: arbitrary address/value outputs (e.g., COINPay native coin payments)
- **Token-gated content support**: encodes [FILE v1](https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/actions/FILE.md) gated files and `BATCH(FILE, MESSAGE)` issuer-publish flows; ciphertext travels as `rawData` via P2WSH alongside the action string
- **JSON-RPC API**: Express server with Helmet security headers, optional API key auth, configurable rate limiting, CORS
- **Browser bundle**: Browserify build for client-side PSBT generation without a server
- **769+ tests**: unit, integration, e2e, boundary, security, fuzz, chaos, mutation, regression, performance, smoke

## Documentation

Full encoder documentation is available in the [xchain-documentation](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/encoder) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/encoder/README.md) | Overview, encoding process, format details, API, testing, configuration |
| [Format Selection](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/encoder/FORMAT_SELECTION.md) | Decision guide for encoding formats with size limits and trade-offs |

## Quick Start

```bash
git clone https://github.com/XChain-Platform/xchain-encoder.git
cd xchain-encoder
npm install
```

Create a `.env` file:

```env
NETWORK=bitcoin-regtest
NODE_URL=127.0.0.1
NODE_PORT=8332
NODE_USER=rpcuser
NODE_PASSWORD=rpcpass
ENCODER_API_PORT=3000
```

Start the encoder:

```bash
npm run api
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `NETWORK` | Yes | (none) | Coin and network (`bitcoin-mainnet`, `dogecoin-testnet`, `litecoin-regtest`, etc.) |
| `NODE_URL` | Yes | (none) | Coin node RPC host (e.g., `127.0.0.1`) |
| `NODE_PORT` | Yes | (none) | Coin node RPC port |
| `NODE_USER` | Yes | (none) | RPC username |
| `NODE_PASSWORD` | Yes | (none) | RPC password |
| `ENCODER_API_PORT` | No | `3000` | JSON-RPC API port |
| `DUST_AMOUNT` | No | Network default | Minimum output value in satoshis |
| `UTXO_TRACKER_URL` | No | (none) | xchain-utxo-tracker service host |
| `UTXO_TRACKER_API_PORT` | No | (none) | xchain-utxo-tracker service port |
| `MAX_FEE_RATE_KB` | No | Uncapped | Absolute maximum fee rate in sat/kB |
| `MAX_FEE_RATE_MULTIPLIER` | No | `100` | Caps caller-supplied fee/feePerKb at this multiple of the node's fee estimate (`0` disables) |
| `API_KEY` | No | Disabled | API key for `x-api-key` header authentication |
| `ENCODER_RATE_LIMIT_RPM` | No | `60` | Maximum requests per minute per IP |
| `ENCODER_MAX_CONCURRENT_REQUESTS` | No | `50` | Global cap on requests served at once across all client IPs; excess gets an immediate 429 + `Retry-After` instead of queueing. `GET /status` and `GET /openrpc.json` are exempt; `0` disables |
| `ENCODER_MAX_CONCURRENT_PROBES` | No | `16` | Private concurrency reserve for the two exempt probe routes, so healthchecks stay answerable while the cap above sheds without becoming an uncapped bypass; `0` disables |
| `ENCODER_TRUST_PROXY` | No | `loopback, uniquelocal` | Express `trust proxy` setting; controls which hop the per-IP rate limiter keys the client IP on. `false`, a hop count, or an address/CIDR list per the Express docs |
| `CORS_ORIGIN` | No | Disabled | CORS origin (`*` to allow all) |

## Metrics and log shipping (optional, off by default)

A Prometheus `/metrics` endpoint and a structured log shim ship with this
service and stay inert unless switched on: with no env set, no route is
registered, no timer starts and no socket opens. Turn the endpoint on with
`METRICS_ENABLED=1` (add `METRICS_TOKEN` to gate the scrape on a reachable
box), and ship logs with `LOG_SHIP_ENABLED=1` plus `LOG_SHIP_URL`. Full
variable list and the exported metric names are in
[`src/observability/README.md`](src/observability/README.md).

The module is vendored byte-identically from xchain-hub . Edit it there
and re-run `xchain-hub/bin/sync-observability.sh`; a local edit fails the
parity gate in `bin/check-observability-parity.js`.

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the JSON-RPC API server |
| `npm run build` | Production browser bundle (minified) -> `dist/xchain_encoder.min.js` |
| `npm run build:dev` | Development browser bundle (unminified) |
| `npm run smoke-test` | Smoke tests (~10 tests, <1s) |
| `npm run test:unit` | Unit tests (114 tests) |
| `npm run test:integration` | Integration tests (108 tests) |
| `npm run test:boundary` | Boundary condition tests (~120 tests) |
| `npm run test:chaos` | Chaos engineering tests (61 tests) |
| `npm run test:regression` | Regression tests (196 tests) |
| `npm run mutate` | Full mutation testing via StrykerJS |
| `npm run mutate:quick` | Quick mutation check (XChainEncoder.js only) |
| `npm run bench` | Performance benchmarks |
| `npm run bench:full` | Extended benchmarks with JSON output |
| `npm run bench:soak` | Soak test (sustained load) |
| `npm test` | Unit tests (hermetic, no external services) |
| `npm run test:regtest` | Regtest integration tests (requires local bitcoind) |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit | 114 | `XChainEncoder.createTransaction`, `prepareData`, `obfuscate`, `dataToPubkey`, `isSegwitUTXO`, `TxSizeEstimator`, `CryptoNetworks` |
| Integration | 108 | ACTION encoding fidelity, encoding type selection, obfuscation round-trip, UTXO/fee interaction, multi-chain, custom outputs, error handling |
| E2E | ~80 | Full pipeline: API layer, P2SH/P2WSH two-tx orchestration, round-trip encode/decode, multi-chain, edge cases |
| Smoke | ~10 | Module loading, instantiation, network configs, basic PSBT creation, API startup |
| Boundary | ~120 | Payload size limits, chunk boundaries, fee calculation edges, UTXO values, change address, custom outputs, obfuscation |
| Chaos | 61 | Network failures, input corruption, library monkey-patching, arithmetic edge cases, resource exhaustion, API resilience |
| Mutation | StrykerJS | 896 mutants across `XChainEncoder.js`, `validator.js`, `TxSizeEstimator.js`, `CryptoNetworks.js` |
| Regression | 196 | Curated critical-path suite: encoding types, obfuscation, fee/UTXO, validator, multi-chain, P2SH/P2WSH, ACTION pipeline, API contract |
| Performance | 3 suites | Baseline benchmarks, full benchmarks with JSON, sustained soak tests |
| **Total** | **769+** | |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/LICENSING.html).
