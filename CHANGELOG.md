# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-04-02

### Added
- Comprehensive unit test suite (113 tests) covering all encoder modules: prepareData, obfuscate, dataToPubkey, isSegwitUTXO, TxSizeEstimator, CryptoNetworks, and createTransaction
- `npm run test:unit` script for running unit tests without external dependencies

## [0.1.0] - 2026-04-02

### Added
- Implement customOutputs support in createTransaction: adds arbitrary payment outputs to PSBTs alongside OP_RETURN data, with proper value tracking and fee estimation (enables COINPay native coin payments)
