# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
