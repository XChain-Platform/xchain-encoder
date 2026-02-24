# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the JSON-RPC API server (reads from .env)
npm run api

# Run all tests (requires bitcoind installed and on PATH)
npm test

# Run a single test file
npx mocha --timeout 0 --require ./test/prepareRegtest.test.js test/XChainEncoder.test.js

# Production browser bundle (minified) → dist/xchain_encoder.min.js
npm run build

# Development browser bundle (unminified) → dist/xchain_encoder.min.js
npm run build:dev
```

## Test Requirements

Tests require a local `bitcoind` binary on PATH. The `prepareRegtest.test.js` Mocha root hook automatically:
1. Stops any running regtest node via `bitcoin-cli -regtest stop`
2. Clears `~/.bitcoin/regtest`
3. Starts `bitcoind -regtest -daemon -fallbackfee=1.0 -maxtxfee=1.1`
4. Creates a `test-wallet` and generates 101 blocks

The node runs on port `8333` with credentials `rpc`/`rpc`. The `api.test.js` suite additionally requires the API server running on port `3000` (start separately with `npm run api`).

## Architecture

The encoder has two deployment modes that share the same core:
- **API server** (`src/api.js`): Express + JSON-RPC server, started with `npm run api`, configured entirely via environment variables from `.env`
- **Browser library** (`src/index.js`): Browserified bundle exposing `window.XChainEncoder`

### Core Data Flow

`XChainEncoder.createTransaction()` in `src/XChainEncoder.js` is the single entry point for both modes. It:
1. Fetches fee rate from the connected node via `BlockchainConnector.getFeePerKilobyte()`
2. Calls `prepareData()` to split data into output-type-specific chunks, each prefixed with the `"XCHN"` magic word
3. Obfuscates each chunk with AES-128-CTR using the first input's TXID as the key+IV
4. Adds data outputs to a `bitcoinjs-lib` PSBT
5. Iterates UTXOs (largest-first) until inputs cover outputs + estimated fee
6. Returns a `{ psbt, encode_type }` object; the caller signs and broadcasts

### Output Types & Data Capacity

Auto-selection: data ≤76 bytes → `OP_RETURN`; larger → `P2SH`.

| Type | Max bytes/output | Notes |
|------|-----------------|-------|
| `OP_RETURN` | 76 (80 − 4 magic) | Single-tx encoding |
| `P2SH` | 476 (520 − 44 overhead) | Two-tx: tx1 creates P2SH output; tx2 spends it, embedding data in redeem script |
| `P2WSH` | ~9956 | Same two-tx pattern as P2SH but uses witness |
| `MULTISIGN` | 65 (71 − overhead) | Data split across two fake public keys in a 1-of-3 multisig output |

**P2SH/P2WSH two-transaction pattern**: Call `createTransaction()` once to get tx1 (the funding tx). Then call it again passing `p2shHash=tx1.getId()` and `p2shHex=tx1.toHex()` to get tx2 (the spending tx that reveals the data). Broadcast tx1 first, mine a block, then broadcast tx2.

### Supporting Classes

- **`BlockchainConnector`** — HTTP JSON-RPC client for the coin daemon (`getrawtransaction`, `estimatesmartfee`, `getnetworkinfo`)
- **`UtxoTracker`** — Optional client for the external xchain-utxo-tracker service; called only when `utxosList` is not provided to `createTransaction()`
- **`TxSizeEstimator`** — Static utility for pre-signing fee estimation; estimates size by UTXO script type (P2WPKH, P2WSH, P2PKH, P2SH)
- **`CryptoNetworks`** — Maps network name strings (`bitcoin-mainnet`, `dogecoin-testnet`, `litecoin-regtest`, etc.) to bitcoinjs-lib network config objects

### Environment Variables

See README.md for the full table. Key variables:
- `NETWORK` — e.g., `bitcoin-regtest`, `dogecoin-mainnet`, `litecoin-testnet`
- `NODE_URL`, `NODE_PORT`, `NODE_USER`, `NODE_PASSWORD` — Bitcoin Core RPC connection
- `DUST_AMOUNT` — minimum fee/output value in satoshis (parsed as integer)
- `UTXO_TRACKER_URL`, `UTXO_TRACKER_API_PORT` — optional external UTXO service
- `ENCODER_API_PORT` — defaults to `3000`
