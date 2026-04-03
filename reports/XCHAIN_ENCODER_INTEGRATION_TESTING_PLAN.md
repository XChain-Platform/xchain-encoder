# XChain Encoder — Integration Testing Plan

## 1. Rationale

The `xchain-encoder` is the single point of transaction construction for the entire XChain Platform. Every token operation — issuance, transfer, DEX order, file upload — passes through `XChainEncoder.createTransaction()` to become a blockchain-valid PSBT. Errors at this layer are catastrophic:

- **Invalid PSBTs** — transactions that fail to broadcast, silently losing gas fees paid by the user.
- **Corrupted ACTION payloads** — data that decodes to a different ACTION than intended, potentially moving tokens to wrong addresses or minting incorrect supply.
- **Funds at risk** — incorrect UTXO selection, fee estimation, or change output logic can burn satoshis or leave change unspendable.
- **Cross-service divergence** — if the encoder produces payloads that the decoder cannot round-trip, the entire pipeline breaks silently.

The existing test suite covers encoding types (OP_RETURN, P2SH, P2WSH, MULTISIGN) with generic string payloads against a live regtest node. What it does **not** cover is the integration between realistic ACTION payloads and the encoder's chunking/obfuscation/PSBT construction — i.e., verifying that the encoder faithfully embeds the pipe-delimited ACTION strings that the rest of the platform depends on.

---

## 2. Current Test Coverage Assessment

### What exists today

| Test File | Type | Scope |
|---|---|---|
| `test/XChainEncoder.test.js` | Integration (regtest) | 4 tests: OP_RETURN, P2SH, P2WSH, MULTISIGN — all use generic string data, broadcast to regtest, decode and verify. Requires live `bitcoind`. |
| `test/api.test.js` | Integration (API) | 1 test: JSON-RPC `create_tx` call via HTTP. Requires both `bitcoind` and the API server running. |
| `test/unit/XChainEncoder.prepareData.test.js` | Unit | 14 tests: chunking logic, magic word, boundary sizes, round-trip data preservation per encoding type. |
| `test/unit/XChainEncoder.createTransaction.test.js` | Unit | 22 tests: UTXO dedup, sorting, fee handling, change output, RBF, custom outputs, encoding path selection, P2SH tx2 path. Uses mocked `BlockchainConnector` and `UtxoTracker`. |
| `test/unit/XChainEncoder.obfuscate.test.js` | Unit | AES-128-CTR encryption/decryption. |
| `test/unit/XChainEncoder.dataToPubkey.test.js` | Unit | Fake pubkey generation for MULTISIGN. |
| `test/unit/XChainEncoder.isSegwitUTXO.test.js` | Unit | SegWit script detection. |
| `test/unit/TxSizeEstimator.test.js` | Unit | Size estimation per script type. |
| `test/unit/CryptoNetworks.test.js` | Unit | Network config mapping. |

### Gaps identified

1. **No ACTION-specific payloads** — all tests use generic strings (`"Small data"`, `"Really big data for p2sh test..."`). No test verifies that actual pipe-delimited ACTION strings (e.g., `SEND|0|JDOG|1|<addr>`) survive the encode/obfuscate/PSBT pipeline.
2. **No multi-chain coverage** — all integration tests use `bitcoin-regtest`. No tests verify Dogecoin or Litecoin network configs produce valid PSBTs.
3. **No ACTION size-class coverage** — no tests exercise ACTIONs that span encoding type boundaries (e.g., a short SEND that fits OP_RETURN vs. an ISSUE with all 25 fields that requires P2SH).
4. **No BATCH action testing** — BATCH actions join multiple commands with `;` and can produce large payloads requiring P2SH/P2WSH. Not tested.
5. **No custom output + ACTION combination** — COINPAY actions require `customOutputs` (native coin payment outputs) alongside ACTION data. Not tested together.
6. **No obfuscation round-trip with real ACTION data** — the unit tests verify obfuscation works in isolation, but no test verifies that obfuscated ACTION data in a PSBT can be deobfuscated back to the original ACTION string.
7. **No API-level ACTION encoding** — `api.test.js` tests the JSON-RPC interface with `"simple text"` only.
8. **No error path integration** — no tests verify what happens when an ACTION payload is too large for any encoding type, or when encoding-specific constraints are violated.
9. **No fee cap (`maxFeePerBytes`) integration test** — the constructor accepts `MAX_FEE_RATE_KB` but no integration test verifies fee capping behavior.

---

## 3. Target Interfaces & Integration Points

### 3.1 Interface Map

```
                                    ┌─────────────────────┐
                                    │  Caller / API Layer  │
                                    │  (api.js / browser)  │
                                    └──────────┬──────────┘
                                               │
                                    JSON-RPC params or direct call
                                               │
                                               ▼
┌──────────────┐         ┌─────────────────────────────────────────┐
│ BlockchainCo │◄────────│       XChainEncoder.createTransaction() │
│   nnector    │  RPC    │                                         │
│ (fee rate,   │         │  1. Fee resolution                      │
│  raw tx hex) │         │  2. Data compilation (script.compile)   │
└──────────────┘         │  3. prepareData() → chunking            │
                         │  4. obfuscate() → AES-128-CTR           │
┌──────────────┐         │  5. PSBT construction (bitcoinjs-lib)   │
│ UtxoTracker  │◄────────│  6. UTXO selection (largest-first)      │
│ (fallback    │  HTTP   │  7. Fee estimation + change output      │
│  UTXO fetch) │         │                                         │
└──────────────┘         └──────────────────┬──────────────────────┘
                                            │
                                            ▼
                                   { psbt, encoding }
                                            │
                              Caller signs → broadcasts → coin node
                                            │
                                            ▼
                                   xchain-decoder picks up tx
                                   and deobfuscates ACTION
```

### 3.2 Critical Integration Points

| # | Interface | Input Side | Output Side | Risk |
|---|---|---|---|---|
| **I-1** | ACTION string → `data` param | Pipe-delimited ACTION string from SDK/caller | `Buffer.from(data, 'utf8')` → `bitcoin.script.compile()` | Script compilation may alter byte boundaries for certain ACTION content (e.g., embedded opcodes, special characters in TICK names) |
| **I-2** | `prepareData()` → chunking | Compiled data buffer + encoding type | Array of data chunks (prefixed with `XCHN` magic or wrapped in redeem scripts) | Chunking at wrong boundary could split a pipe-delimited field, making the ACTION undecodable |
| **I-3** | `obfuscate()` → AES-128-CTR | Data chunks + first input TXID | Encrypted buffers | Obfuscation key is derived from TXID; if UTXO sorting changes the first input, the key changes and decoder can't deobfuscate |
| **I-4** | Encrypted data → `bitcoinjs-lib` PSBT | Obfuscated buffers | PSBT outputs (OP_RETURN, P2SH, P2WSH, MULTISIGN) | Library-level constraints (max script size, valid pubkeys for MULTISIGN) may reject certain encrypted data patterns |
| **I-5** | UTXO list → PSBT inputs | Array of UTXO objects (from caller or UtxoTracker) | PSBT inputs with correct witness/non-witness structure | Wrong UTXO classification (segwit vs. legacy) → signing failure |
| **I-6** | Fee estimation → change output | `TxSizeEstimator` estimates + fee rate | Change output value | Underestimation → tx rejected by node; overestimation → unnecessary fees |
| **I-7** | `customOutputs` → PSBT outputs | Array of `{address, value}` for COINPAY | Additional PSBT outputs | Custom outputs reduce available change; combined with large ACTION data could exceed available UTXOs |
| **I-8** | API layer → `createTransaction()` | JSON-RPC params (string values) | PSBT hex string | Type coercion at API boundary (e.g., `fee` as string vs. number) |

---

## 4. Test Scenarios

### Category A: ACTION Payload Encoding Fidelity

These tests verify that realistic ACTION strings survive the full encode pipeline and can be decoded back to the original string.

| ID | Scenario | ACTION Payload | Expected Encoding | Verification |
|---|---|---|---|---|
| **A-1** | Minimal SEND (fits OP_RETURN) | `SEND\|0\|JDOG\|1\|<regtest-addr>` | OP_RETURN | Deobfuscate from PSBT output → strip `XCHN` magic → `script.decompile()` → verify pipe-delimited string matches input |
| **A-2** | SEND with memo | `SEND\|0\|JDOG\|100\|<addr>\|Payment for services` | OP_RETURN | Same deobfuscation check; verify memo field preserved |
| **A-3** | Multi-send (version 1) | `SEND\|1\|BRRR\|5\|<addr1>\|1\|<addr2>` | OP_RETURN | Verify multiple `AMOUNT\|DESTINATION` pairs survive |
| **A-4** | ISSUE with all fields (version 0) | `ISSUE\|0\|TEST\|1000\|1\|8\|Description\|100\|<addr>\|<addr>\|1\|1\|1\|0\|1\|1\|0\|\|\|0\|0\|0\|0\|0\|0\|memo` | P2SH (>76 bytes) | Full ISSUE string preserved across P2SH two-tx pattern |
| **A-5** | Short ISSUE (fits OP_RETURN) | `ISSUE\|0\|X` | OP_RETURN | Minimal ISSUE fits in OP_RETURN; verify encoding auto-selection |
| **A-6** | BATCH with multiple commands | `SEND\|0\|A\|1\|<addr>;SEND\|0\|B\|2\|<addr>;DESTROY\|0\|C\|50` | Depends on size | Semicolon-separated commands preserved; no corruption at `;` boundaries |
| **A-7** | BROADCAST with long text | `BROADCAST\|0\|Full oracle message with lots of descriptive text...` (>76 bytes) | P2SH | Large text payloads chunk correctly |
| **A-8** | FILE action (very large payload) | `FILE\|0\|test.json\|application/json\|<base64-of-file-content>` (>520 bytes) | P2WSH | Multi-kilobyte payloads use P2WSH and reconstruct correctly |
| **A-9** | ORDER action | `ORDER\|0\|BUY\|JDOG\|100\|BRRR\|50\|0` | OP_RETURN | DEX order fields preserved |
| **A-10** | DISPENSER action | `DISPENSER\|0\|JDOG\|100\|10\|1\|<addr>\|0\|0` | OP_RETURN | Dispenser params preserved |
| **A-11** | TICK with special characters | `ISSUE\|0\|J-DOG_#1` | OP_RETURN | Special characters in TICK name survive encoding |
| **A-12** | TICK by ID reference | `SEND\|0\|^1234\|100\|<addr>` | OP_RETURN | Caret prefix for TICK_ID preserved |
| **A-13** | Maximum OP_RETURN boundary | Construct ACTION string of exactly 72 bytes (76 - 4 magic) | OP_RETURN | Boundary: fits in single OP_RETURN chunk exactly |
| **A-14** | One byte over OP_RETURN boundary | Construct ACTION string of 73 bytes | P2SH | Verify auto-selection flips to P2SH |

### Category B: Encoding Type Integration

These tests verify each encoding type produces structurally valid PSBTs with correctly embedded data.

| ID | Scenario | Setup | Verification |
|---|---|---|---|
| **B-1** | OP_RETURN: script structure | Small ACTION payload, `encoding=null` | PSBT output[0]: `value=0`, script starts with `OP_RETURN` (0x6a), contains obfuscated `XCHN`-prefixed data |
| **B-2** | P2SH tx1: funding output | Large payload, `encoding=null`, no `p2shHash` | PSBT has P2SH output with `value >= dustAmount`, script is a valid P2SH address |
| **B-3** | P2SH tx2: spending input | Pass `p2shHash` and `p2shHex` from B-2 | PSBT has P2SH input with `redeemScript` containing ACTION data, plus OP_RETURN marker output with obfuscated `XCHNp2sh` |
| **B-4** | P2WSH tx1: funding output | Large payload, `encoding="P2WSH"` | PSBT has P2WSH output, change output |
| **B-5** | P2WSH tx2: spending input | Pass `p2shHash`/`p2shHex` from B-4 | PSBT has witness input with `witnessScript` containing ACTION data, OP_RETURN marker with `XCHNp2wsh` |
| **B-6** | MULTISIGN: output structure | Short payload, `encoding="MULTISIGN"`, `compressedPubKey` provided | PSBT has 1-of-3 multisig output; pubkey[0] and pubkey[1] contain obfuscated data; pubkey[2] is the real key |
| **B-7** | Forced encoding override | Short payload (fits OP_RETURN) with `encoding="P2SH"` explicitly | Encoder uses P2SH despite data fitting in OP_RETURN |
| **B-8** | Multi-chunk OP_RETURN | Payload requiring 3+ OP_RETURN outputs | All chunks present in PSBT; reassembled data matches original |

### Category C: Obfuscation Round-Trip

These tests verify the AES-128-CTR obfuscation/deobfuscation cycle with the TXID-derived key.

| ID | Scenario | Verification |
|---|---|---|
| **C-1** | OP_RETURN obfuscation round-trip | Extract obfuscated data from PSBT OP_RETURN output → deobfuscate using first input TXID → verify `XCHN` prefix + original data |
| **C-2** | MULTISIGN obfuscation round-trip | Extract fake pubkeys from multisig output → strip `0x02` prefix → deobfuscate → verify `XCHN` prefix + original data |
| **C-3** | P2SH marker obfuscation | Extract tx2 OP_RETURN data → deobfuscate → verify `XCHNp2sh` |
| **C-4** | TXID sensitivity | Create same ACTION with two different first-input TXIDs → obfuscated outputs must differ |
| **C-5** | UTXO sorting doesn't break obfuscation key | Provide UTXOs in non-sorted order (smallest first); verify obfuscation key uses the largest UTXO's TXID (since sorting happens before obfuscation) |

### Category D: UTXO & Fee Integration

| ID | Scenario | Verification |
|---|---|---|
| **D-1** | Single large UTXO covers everything | 1 UTXO of 1 BTC, small ACTION, `fee=10000` → 1 input, 2 outputs (OP_RETURN + change) |
| **D-2** | Multiple UTXOs needed | Several small UTXOs, large fee → encoder adds UTXOs until inputs > outputs + fee |
| **D-3** | Duplicate UTXO deduplication | Pass 3 copies of same UTXO → only 1 appears as input |
| **D-4** | Unconfirmed filtering with `unconfirmed=false` | Mix of confirmed + mempool UTXOs → only confirmed used |
| **D-5** | UtxoTracker fallback | Pass `utxos=null` → verify `UtxoTracker.getUtxosFromAddress()` is called |
| **D-6** | No UTXOs available | Empty UTXO set + tracker returns empty → throws `"no utxos"` error |
| **D-7** | Fee capped by `maxFeePerBytes` | Set `maxFeeRateKb=1000`, provide very high `feePerKb` → resulting fee doesn't exceed cap |
| **D-8** | Dust floor on fee | Very low fee rate → fee is floored to `dustAmount` |
| **D-9** | No change address throws when change > dust | Large UTXO, small fee, `change=null` → throws error about burning satoshis |
| **D-10** | Legacy (non-segwit) UTXO handling | Provide a P2PKH UTXO → encoder calls `connector.getTransactionHex()` to get full tx hex for `nonWitnessUtxo` |

### Category E: Custom Outputs (COINPAY Integration)

| ID | Scenario | Verification |
|---|---|---|
| **E-1** | Custom outputs added to PSBT | `customOutputs=[{address, value: "500000"}, {address, value: "300000"}]` → both appear in PSBT outputs with correct values |
| **E-2** | Custom outputs affect fee/change calculation | Total custom output value is deducted from change |
| **E-3** | Non-array `customOutputs` ignored | Pass object instead of array → silently skipped, no crash |
| **E-4** | Custom outputs + large ACTION payload | COINPAY native output + P2SH ACTION data → both present in PSBT |

### Category F: Multi-Chain Network Configs

| ID | Scenario | Verification |
|---|---|---|
| **F-1** | Bitcoin regtest | `network="bitcoin-regtest"` → PSBT uses regtest network params; `dustThreshold=546` |
| **F-2** | Dogecoin regtest | `network="dogecoin-regtest"` → PSBT uses Dogecoin address format; `dustThreshold=546` |
| **F-3** | Litecoin regtest | `network="litecoin-regtest"` → PSBT uses Litecoin bech32 (`rltc` prefix); `dustThreshold=5460` |
| **F-4** | Litecoin higher dust threshold | Same ACTION on Litecoin vs Bitcoin → Litecoin MULTISIGN output value is 5460 (10x Bitcoin's 546) |
| **F-5** | Dogecoin address in P2SH redeem script | Large ACTION + Dogecoin address → P2SH output is valid Dogecoin P2SH address |

### Category G: API Layer Integration

| ID | Scenario | Verification |
|---|---|---|
| **G-1** | JSON-RPC `create_tx` with ACTION payload | `POST /` with `method: "create_tx"` and SEND ACTION as `data` param → response contains `psbt` hex and `encoding` string |
| **G-2** | JSON-RPC `ping` | `POST /` with `method: "ping"` → `{status: "success"}` |
| **G-3** | API returns PSBT as hex string (not object) | Response `psbt` field is a hex string, not a Psbt instance |
| **G-4** | API with P2SH two-tx flow | Call `create_tx` for tx1, then call again with `p2shHash`/`p2shHex` → both return valid hex PSBTs |
| **G-5** | API error propagation | Invalid params (e.g., empty data, no UTXOs) → JSON-RPC error response |

### Category H: Error Handling at Integration Boundaries

| ID | Scenario | Verification |
|---|---|---|
| **H-1** | `BlockchainConnector.getFeePerKilobyte()` failure | Mock connector to throw → `createTransaction()` propagates error |
| **H-2** | `BlockchainConnector.getTransactionHex()` failure | Mock to throw when fetching legacy UTXO hex → error propagated |
| **H-3** | `UtxoTracker` unreachable | Mock to throw → error propagated when `utxos=null` |
| **H-4** | Invalid network name | `new XChainEncoder("invalid-network", ...)` → `CryptoNetworks.getBitcoinJsNetwork()` returns `undefined` → constructor-level or first-call failure |
| **H-5** | MULTISIGN without `compressedPubKey` | `encoding="MULTISIGN"`, `compressedPubKey=null` → throws at `Buffer.from(null, "hex")` |
| **H-6** | P2SH without valid `pubkey` address | `encoding="P2SH"`, `pubkey=null` → throws at `bitcoin.address.fromBase58Check(null)` |

---

## 5. Test Design Strategy

### 5.1 Test Environment Architecture

```
┌─────────────────────────────────────────────────┐
│              Integration Test Suite              │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Mocked Dependencies (for Categories     │    │
│  │  A-F, H — no live node required)         │    │
│  │                                          │    │
│  │  • BlockchainConnector (stub)            │    │
│  │    - getFeePerKilobyte() → fixed value   │    │
│  │    - getTransactionHex() → pre-built hex │    │
│  │    - isRegtest() → true                  │    │
│  │                                          │    │
│  │  • UtxoTracker (stub)                    │    │
│  │    - getUtxosFromAddress() → fixture     │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Live Regtest Tests (Category G,         │    │
│  │  full round-trip validation)             │    │
│  │                                          │    │
│  │  • Requires: bitcoind -regtest           │    │
│  │  • Uses: prepareRegtest.test.js hooks    │    │
│  │  • Signs PSBTs with test keys            │    │
│  │  • Broadcasts to regtest                 │    │
│  │  • Fetches tx and decodes payload        │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Deobfuscation Helper (shared utility)   │    │
│  │                                          │    │
│  │  • AES-128-CTR decrypt with TXID key     │    │
│  │  • Magic word verification               │    │
│  │  • Script decompilation                  │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### 5.2 Mock Design

**BlockchainConnector mock** (reuse pattern from existing `test/unit/XChainEncoder.createTransaction.test.js`):

```
encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,        // ~1 sat/byte
    getTransactionHex: async () => ({ hex: RAW_TX_HEX }),
    isRegtest: async () => true
}
```

**UtxoTracker mock:**

```
encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
        utxos: [{ txid, vout, value, confirmations, scriptPubKey }]
    })
}
```

**UTXO fixture factory:**

Create helpers that generate segwit (P2WPKH) and legacy (P2PKH) UTXO objects with deterministic TXIDs. The existing `makeSegwitUtxo()` and `buildRawTxHex()` in the unit tests provide a good pattern to follow.

**ACTION payload factory:**

Create helpers that generate well-formed ACTION strings for each of the 19 ACTION types. These should use the exact pipe-delimited format from the protocol documentation and return both the `data` string and optional `rawData` string that `createTransaction()` expects.

### 5.3 Assertion Patterns

For each test category, use these assertion strategies:

**Payload fidelity (Categories A, C):**
1. Call `createTransaction()` with ACTION payload
2. Extract data from PSBT outputs (per encoding type)
3. Deobfuscate using the first input's TXID as key
4. Verify `XCHN` magic prefix
5. Use `bitcoin.script.decompile()` to extract the original data
6. Compare against the original ACTION string byte-for-byte

**PSBT structure (Categories B, E):**
1. Verify `result.psbt instanceof bitcoin.Psbt`
2. Check `result.psbt.txOutputs` count and types
3. Check `result.psbt.data.inputs` count and structure
4. Verify specific output script opcodes via `bitcoin.script.decompile()`

**Error handling (Category H):**
1. Use `assert.rejects()` for async error tests
2. Verify error message content (not just that it throws)

### 5.4 Test File Organization

```
test/
├── integration/
│   ├── action-encoding.test.js       # Category A: ACTION payload fidelity
│   ├── encoding-types.test.js         # Category B: Encoding type integration
│   ├── obfuscation-roundtrip.test.js  # Category C: Obfuscation round-trip
│   ├── utxo-fee.test.js               # Category D: UTXO & fee integration
│   ├── custom-outputs.test.js         # Category E: Custom outputs
│   ├── multi-chain.test.js            # Category F: Multi-chain configs
│   ├── api.test.js                    # Category G: API layer integration
│   ├── error-handling.test.js         # Category H: Error paths
│   └── helpers/
│       ├── actionFactory.js           # ACTION string generators
│       ├── utxoFactory.js             # UTXO fixture generators
│       └── deobfuscate.js             # Shared deobfuscation utility
```

### 5.5 Deobfuscation Utility

A critical shared helper for verifying encoded payloads. Note: the existing `nodeHelper.removeObfuscation()` uses `aes-128-cbc` (likely a bug — the encoder uses `aes-128-ctr`). The integration test helper must use `aes-128-ctr` to match the encoder:

```
function deobfuscate(data, txid) {
    const key = txid.substr(0, 16)
    const iv  = txid.substr(16, 16)
    const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv)
    return Buffer.concat([decipher.update(data), decipher.final()])
}
```

### 5.6 ACTION Payload Factory Design

Each factory function returns `{ data, rawData }` matching `createTransaction()` parameters:

| ACTION | Factory Signature | Size Class |
|---|---|---|
| `SEND` v0 | `makeSend(tick, amount, dest, memo?)` | Small (OP_RETURN) |
| `SEND` v1 | `makeMultiSend(tick, transfers[])` | Medium |
| `ISSUE` v0 (full) | `makeIssue(tick, allParams)` | Large (P2SH) |
| `ISSUE` v0 (minimal) | `makeIssueMinimal(tick)` | Small (OP_RETURN) |
| `BATCH` | `makeBatch(actions[])` | Variable |
| `FILE` | `makeFile(name, mime, content)` | Very large (P2WSH) |
| `ORDER` | `makeOrder(type, give, amount, get, amount)` | Small |
| `DISPENSER` | `makeDispenser(tick, amount, per, status)` | Small |
| `BROADCAST` | `makeBroadcast(text)` | Variable |
| `DESTROY` | `makeDestroy(tick, amount)` | Small |
| etc. | One per ACTION type | Varies |

---

## 6. Priority & Execution Order

### Phase 1: Foundation (High Priority)

1. **Shared test helpers** — deobfuscation utility, UTXO factory, ACTION factory
2. **Category A (A-1 through A-6)** — core ACTION encoding fidelity for the most common actions (SEND, ISSUE, BATCH, ORDER)
3. **Category C (C-1, C-5)** — obfuscation round-trip and UTXO sorting key stability

These tests catch the highest-impact bugs: ACTION data corruption, which would silently break the entire platform.

### Phase 2: Encoding Depth (High Priority)

4. **Category B (B-1 through B-6)** — all four encoding types produce valid PSBTs
5. **Category A (A-13, A-14)** — OP_RETURN boundary tests

These tests catch encoding-selection bugs that could cause transaction broadcast failures.

### Phase 3: UTXO & Fee (Medium Priority)

6. **Category D (D-1 through D-10)** — UTXO handling and fee estimation

Much of this is already covered by unit tests, but integration tests add confidence with realistic ACTION payloads.

### Phase 4: Multi-Chain & API (Medium Priority)

7. **Category F (F-1 through F-5)** — Dogecoin and Litecoin network configs
8. **Category G (G-1 through G-5)** — API layer tests (requires live regtest)

### Phase 5: Edge Cases & Errors (Lower Priority)

9. **Category E (E-1 through E-4)** — custom outputs
10. **Category H (H-1 through H-6)** — error handling at boundaries
11. **Category A (A-7 through A-12)** — remaining ACTION types

---

## 7. Key Findings & Recommendations

### 7.1 Potential Bug: `nodeHelper.removeObfuscation()` uses wrong cipher

The existing test helper at `test/nodeHelper.js:115` uses `aes-128-cbc` while the encoder uses `aes-128-ctr`. This means the existing regtest round-trip tests may be passing due to short data where CBC and CTR produce similar results, or there may be a compensating factor. This should be investigated before writing new integration tests, as it affects the deobfuscation verification helper.

### 7.2 The `data`/`rawData` dual-parameter pattern

`createTransaction()` accepts both `data` and `rawData`, which are compiled together via `bitcoin.script.compile([dataBuffer, rawDataBuffer])`. The protocol documentation doesn't clearly explain when `rawData` is used vs. when all content goes in `data`. Integration tests should cover both patterns:
- `data` only (most ACTIONs)
- `data` + `rawData` (appears to be used for additional metadata)

### 7.3 Encoding auto-selection only chooses OP_RETURN or P2SH

When `encoding` is `null`/`undefined`, `prepareData()` only auto-selects between `OP_RETURN` and `P2SH`. It never auto-selects `P2WSH` or `MULTISIGN`. This is by design but should be documented in tests — callers must explicitly request these encoding types.

### 7.4 MULTISIGN requires valid EC curve points

The MULTISIGN path creates fake public keys by prepending `0x02` to obfuscated data. Not all 32-byte values are valid x-coordinates on secp256k1. The existing unit tests handle this with a brute-forced TXID (`TXID_MS`). Integration tests for MULTISIGN must use similarly validated TXIDs, or generate them dynamically.

### 7.5 Test independence from live blockchain

Categories A through F and H should all run with mocked dependencies (no `bitcoind` required). Only Category G requires a live regtest node. This enables fast CI/CD integration for the core test suite while keeping full end-to-end validation as a separate, slower test tier.

---

## 8. Success Criteria

The integration test suite will be considered complete when:

1. All 19 ACTION types have at least one encoding fidelity test (Category A)
2. All 4 encoding types (OP_RETURN, P2SH, P2WSH, MULTISIGN) have structural validation tests (Category B)
3. Obfuscation round-trip is verified for all encoding types (Category C)
4. All 3 supported chains (Bitcoin, Dogecoin, Litecoin) have PSBT construction tests (Category F)
5. The API layer has end-to-end tests with ACTION payloads (Category G)
6. All known error paths have explicit tests (Category H)
7. Tests run in < 5 seconds for mocked tests, < 30 seconds for regtest tests
8. Zero dependency on network state — mocked tests produce deterministic results

---

*Generated: 2026-04-02*
*Target Component: xchain-encoder v1.x*
*Test Framework: Mocha with `--timeout 0`*
