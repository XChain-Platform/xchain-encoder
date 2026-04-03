# XChain Encoder: End-to-End Testing Plan

**Date:** 2026-04-02
**Component:** xchain-encoder
**Scope:** Full pipeline validation from ACTION configuration input to broadcastable PSBT output

---

## 1. Rationale: Why E2E Testing for the Encoder

The xchain-encoder sits at the critical entry point of the on-chain data pipeline. Every token operation (SEND, ISSUE, ORDER, DISPENSER, etc.) depends on the encoder producing a PSBT whose embedded payload can be correctly deobfuscated and decoded by downstream services (xchain-decoder, xchain-indexer). A subtle encoding error -- wrong format selection, corrupted obfuscation, malformed script structure -- would propagate silently through the entire system, potentially producing invalid on-chain state that is expensive or impossible to correct.

The existing integration test suite (Categories A-H) provides strong coverage of individual concerns (payload fidelity, encoding types, obfuscation, UTXO handling, fee logic, multi-chain, custom outputs, error boundaries). However, it tests these concerns in isolation using `makeEncoder()` with mocked connectors. **True E2E tests must validate the full orchestrated flow** -- from a realistic ACTION configuration entering through the JSON-RPC API layer, through all internal pipeline stages, to a structurally valid PSBT that a wallet could sign and broadcast.

Key risks that only E2E tests can catch:
- **API-layer parameter marshalling**: The JSON-RPC `create_tx` handler transforms params before calling `createTransaction()`. Type coercions, missing defaults, or parameter ordering bugs in `api.js` are invisible to tests that call `createTransaction()` directly.
- **Two-transaction P2SH/P2WSH orchestration**: The tx1 -> tx2 dance requires the output of one `createTransaction()` call to feed into the next. Tests must validate this full sequence produces a coherent pair.
- **Round-trip decode consistency**: An encoded PSBT that survives internal assertions but produces a different ACTION when decoded by `xchain-decoder` would be catastrophic. Conceptual round-trip tests validate cross-service contract alignment.
- **Multi-chain address/script divergence**: Dogecoin and Litecoin network parameters affect P2SH addresses, dust thresholds, and script formats in ways that compound across the pipeline.

---

## 2. Test Environment Strategy

### 2.1 Environment Setup

E2E tests for the encoder operate in **two tiers**, each with different infrastructure requirements:

**Tier 1: Offline E2E (No Live Node)**
- Instantiate the full `XChainEncoder` class with real network configs
- Mock only the external I/O boundary: `BlockchainConnector` RPC calls and `UtxoTracker` HTTP calls
- Use the existing `utxoFactory.js` helpers for deterministic UTXO fixtures
- Use the existing `deobfuscate.js` helpers for payload extraction and verification
- Exercise the complete internal pipeline: script compilation -> `prepareData()` -> obfuscation -> PSBT construction
- **Advantages**: Fast, deterministic, CI-friendly, no infrastructure dependencies
- **When to use**: All tests except broadcast verification

**Tier 2: Live Node E2E (Regtest)**
- Start a local `bitcoind -regtest` (as in `prepareRegtest.test.js`)
- Start the encoder API server on a test port
- Send JSON-RPC requests to the API, receive PSBT hex responses
- Sign the returned PSBTs and broadcast to regtest
- Verify the transaction appears in the mempool/block
- **Advantages**: Validates the full API layer, real PSBT signing, real broadcast
- **When to use**: Smoke tests, pre-release validation, CI nightly

### 2.2 Test Framework

- **Framework**: Mocha with `--timeout 0` (consistent with existing project convention)
- **Assertions**: Node.js built-in `assert` module (no additional dependencies)
- **Test helpers**: Extend existing `actionFactory.js`, `utxoFactory.js`, `deobfuscate.js`
- **No Jest**: The project uses Mocha throughout; switching frameworks for E2E adds unnecessary friction

### 2.3 Test Data Strategy

- Use `actionFactory.js` builder functions for all ACTION payloads (already covers all 19+ ACTION types)
- Use `utxoFactory.js` for deterministic UTXO fixtures (segwit, legacy, mempool, multi-value)
- Extend `actionFactory.js` with additional edge-case builders as needed (see Section 3)
- All test data should be self-contained and deterministic -- no external state dependencies

---

## 3. Critical E2E Scenarios

### Category E2E-1: Full ACTION-to-PSBT Pipeline per ACTION Type

**Objective**: Verify that every supported ACTION type, when provided as a realistic configuration, produces a valid PSBT with correctly embedded and recoverable payload.

| ID | Scenario | ACTION | Encoding | Verification |
|---|---|---|---|---|
| E2E-1.1 | Simple token send | `SEND\|0\|JDOG\|100\|<addr>` | OP_RETURN | Deobfuscate -> verify exact ACTION string match |
| E2E-1.2 | Send with memo | `SEND\|0\|JDOG\|100\|<addr>\|Payment` | OP_RETURN | Verify memo field preserved |
| E2E-1.3 | Multi-output send (v1) | `SEND\|1\|TICK\|AMT\|DEST\|AMT\|DEST` | OP_RETURN | All amount/dest pairs preserved |
| E2E-1.4 | Multi-token send (v2) | `SEND\|2\|TICK1\|AMT\|DEST\|TICK2\|AMT\|DEST` | OP_RETURN | Multi-token fields preserved |
| E2E-1.5 | Multi-token+memo send (v3) | `SEND\|3\|TICK\|AMT\|DEST\|MEMO\|...` | OP_RETURN | Per-transfer memo preserved |
| E2E-1.6 | Full token issuance | `ISSUE\|0\|TICK\|<25+ fields>` | P2SH | All 25+ fields survive P2SH two-tx encode; P2SH script structure valid |
| E2E-1.7 | Minimal token issuance | `ISSUE\|0\|X` | OP_RETURN | Auto-selects OP_RETURN; single-field ISSUE preserved |
| E2E-1.8 | Description edit | `ISSUE\|1\|TICK\|<desc>` | OP_RETURN | Version 1 format preserved |
| E2E-1.9 | Token mint | `MINT\|0\|TICK\|AMOUNT` | OP_RETURN | Amount precision preserved |
| E2E-1.10 | Token destroy | `DESTROY\|0\|TICK\|AMOUNT` | OP_RETURN | Burn amount preserved |
| E2E-1.11 | Callback trigger | `CALLBACK\|0\|TICK` | OP_RETURN | Minimal payload preserved |
| E2E-1.12 | Sleep/pause | `SLEEP\|0\|TICK\|BLOCK` | OP_RETURN | Block number preserved |
| E2E-1.13 | Address sweep | `SWEEP\|0\|<dest>` | OP_RETURN | Destination address preserved |
| E2E-1.14 | Airdrop | `AIRDROP\|0\|TICK\|LIST_IDX\|AMT` | OP_RETURN | List index reference preserved |
| E2E-1.15 | Dividend | `DIVIDEND\|0\|TICK\|DIV_TICK\|AMT` | OP_RETURN | Two-tick relationship preserved |
| E2E-1.16 | DEX order (BUY) | `ORDER\|0\|BUY\|GIVE\|AMT\|GET\|AMT\|EXP` | OP_RETURN | All DEX fields preserved |
| E2E-1.17 | DEX order (SELL) | `ORDER\|0\|SELL\|GIVE\|AMT\|GET\|AMT\|EXP` | OP_RETURN | Type field = SELL preserved |
| E2E-1.18 | Coinpay | `COINPAY\|0\|<order_idx>` | OP_RETURN | Order match index preserved |
| E2E-1.19 | Dispenser | `DISPENSER\|0\|TICK\|GIVE\|PER\|STATUS\|DEST\|0\|0` | OP_RETURN | All dispenser params preserved |
| E2E-1.20 | Cross-chain swap | `SWAP\|0\|TICK\|AMT\|CHAIN\|DTICK\|DAMT` | OP_RETURN | Cross-chain identifiers preserved |
| E2E-1.21 | Broadcast message | `BROADCAST\|0\|<text>` | OP_RETURN | Message text preserved |
| E2E-1.22 | Direct message | `MESSAGE\|0\|<dest>\|<text>` | OP_RETURN | Address + text preserved |
| E2E-1.23 | File storage (small) | `FILE\|0\|name\|mime\|<content>` | P2SH | File metadata + content preserved |
| E2E-1.24 | File storage (large) | `FILE\|0\|name\|mime\|<1KB+ content>` | P2WSH | Large payload handled via witness |
| E2E-1.25 | Address metadata | `ADDRESS\|0\|1` | OP_RETURN | Require-memo flag preserved |
| E2E-1.26 | Link actions | `LINK\|0\|42\|99` | OP_RETURN | Action indices preserved |
| E2E-1.27 | List creation | `LIST\|0\|addr1,addr2,...` | OP_RETURN | Comma-separated items preserved |
| E2E-1.28 | Batch (multi-action) | `SEND\|0\|...\;DESTROY\|0\|...` | OP_RETURN | Semicolon delimiter + both actions preserved |
| E2E-1.29 | Large batch | 5+ actions joined with `;` | P2SH | Batch exceeding OP_RETURN auto-selects P2SH |
| E2E-1.30 | TICK by ID reference | `SEND\|0\|^1234\|100\|<addr>` | OP_RETURN | Caret prefix preserved |

**Verification Strategy for each test:**
1. Construct ACTION via `actionFactory` builder
2. Call `createTransaction()` with realistic UTXO set and parameters
3. Assert `result.encoding` matches expected type
4. Assert `result.psbt` is a valid `bitcoinjs-lib` Psbt instance
5. For OP_RETURN: extract payload via `extractOpReturnPayload()`, verify XCHN magic, decompile, assert exact string match
6. For P2SH: verify P2SH output script structure (OP_HASH160 <20-byte> OP_EQUAL), verify output value >= dust
7. For P2WSH: verify witness output script (OP_0 <32-byte>)
8. For MULTISIGN: verify 1-of-3 multisig script structure, extract via `extractMultisignPayload()`

---

### Category E2E-2: Two-Transaction P2SH/P2WSH Orchestration

**Objective**: Validate the full tx1 -> tx2 sequence for P2SH and P2WSH encoding, ensuring the spending transaction correctly references and reveals the data.

| ID | Scenario | Verification |
|---|---|---|
| E2E-2.1 | P2SH full sequence (ISSUE) | tx1 creates P2SH output; tx2 spends it with redeemScript containing obfuscated ACTION data; redeemScript decompiles to [data] OP_DROP OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG |
| E2E-2.2 | P2SH tx2 marker | tx2 has OP_RETURN output that deobfuscates to `XCHNp2sh` |
| E2E-2.3 | P2SH data fidelity | Extract redeemScript data from tx2, deobfuscate, verify original ACTION string |
| E2E-2.4 | P2WSH full sequence (FILE) | tx1 creates P2WSH output; tx2 spends it with witnessScript; witnessScript contains obfuscated data |
| E2E-2.5 | P2WSH tx2 marker | tx2 OP_RETURN marker deobfuscates to `XCHNp2sh` |
| E2E-2.6 | P2WSH data fidelity | Extract witnessScript data, deobfuscate, verify original file content |
| E2E-2.7 | tx1 -> tx2 ID chaining | tx2's p2shHash param matches tx1's transaction ID exactly |
| E2E-2.8 | tx1 -> tx2 hex chaining | tx2's p2shHex param matches tx1's raw hex exactly |
| E2E-2.9 | Multi-chunk P2SH | ACTION large enough to require multiple P2SH outputs; all chunks reassemble correctly |

---

### Category E2E-3: Encoding Type Selection & Boundaries

**Objective**: Verify the auto-selection logic and forced encoding overrides produce correct PSBTs at size boundaries.

| ID | Scenario | Input Size | Expected Encoding | Verification |
|---|---|---|---|---|
| E2E-3.1 | Minimum OP_RETURN | 1-byte ACTION | OP_RETURN | Single OP_RETURN output with valid payload |
| E2E-3.2 | Maximum OP_RETURN | 75-byte ACTION (compiles to 76 bytes + 4 magic = 80) | OP_RETURN | Fits exactly; no overflow to P2SH |
| E2E-3.3 | OP_RETURN+1 boundary | 76+ byte ACTION (compiled > 76 bytes) | P2SH | Auto-selects P2SH |
| E2E-3.4 | Forced OP_RETURN (large) | 200-byte ACTION, encoding='OP_RETURN' | OP_RETURN | Multiple OP_RETURN outputs (multi-chunk) |
| E2E-3.5 | Forced P2SH (small) | Small ACTION, encoding='P2SH' | P2SH | Override honored despite data fitting OP_RETURN |
| E2E-3.6 | Forced P2WSH | Medium ACTION, encoding='P2WSH' | P2WSH | P2WSH output with witness script |
| E2E-3.7 | Forced MULTISIGN | Small ACTION, encoding='MULTISIGN' | MULTISIGN | 1-of-3 multisig output |
| E2E-3.8 | P2SH max chunk | 436-byte chunk within P2SH | P2SH | Single P2SH output, no overflow |
| E2E-3.9 | P2WSH max chunk | 9956-byte chunk within P2WSH | P2WSH | Single P2WSH output |

---

### Category E2E-4: Obfuscation Integrity

**Objective**: Ensure AES-128-CTR obfuscation with TXID-derived keys produces data that is reversible and non-trivially encoded.

| ID | Scenario | Verification |
|---|---|---|
| E2E-4.1 | OP_RETURN round-trip | Obfuscated data in PSBT output deobfuscates to XCHN + original ACTION |
| E2E-4.2 | MULTISIGN round-trip | Fake pubkey data extracted and deobfuscated recovers XCHN + original data |
| E2E-4.3 | P2SH redeemScript round-trip | tx2 redeemScript data deobfuscated with tx1 ID recovers ACTION |
| E2E-4.4 | TXID sensitivity | Same ACTION with different TXIDs produces different ciphertext but same plaintext after deobfuscation |
| E2E-4.5 | UTXO sort stability | Obfuscation key derives from the largest-value UTXO's txid regardless of input array order |
| E2E-4.6 | Wrong TXID detection | Deobfuscation with incorrect TXID does not produce XCHN magic (negative test) |
| E2E-4.7 | Multi-chunk consistency | Each chunk in a multi-output OP_RETURN is independently deobfuscatable with same TXID key |

---

### Category E2E-5: UTXO, Fee, and Change Integration

**Objective**: Validate that PSBT input selection, fee calculation, and change outputs are correct for realistic scenarios.

| ID | Scenario | Verification |
|---|---|---|
| E2E-5.1 | Single UTXO covers all | 1 input, OP_RETURN + change outputs; change = input - fee |
| E2E-5.2 | Multiple UTXOs aggregated | Progressively adds UTXOs (largest-first) until inputs >= outputs + fee |
| E2E-5.3 | UTXO deduplication | Duplicate (txid, vout) pairs collapsed to unique set |
| E2E-5.4 | Unconfirmed excluded | Mempool UTXOs filtered when `unconfirmed=false` |
| E2E-5.5 | Unconfirmed included | Mempool UTXOs used when `unconfirmed=true` |
| E2E-5.6 | UtxoTracker fallback | Null/empty UTXOs trigger UtxoTracker call |
| E2E-5.7 | Fee floor enforcement | Computed fee below dustAmount is raised to dustAmount |
| E2E-5.8 | Fee cap enforcement | High feePerKb capped by maxFeeRateKb |
| E2E-5.9 | No change address error | Missing change address with remaining funds throws descriptive error |
| E2E-5.10 | Legacy UTXO handling | P2PKH UTXO triggers `getTransactionHex()` call; input has `nonWitnessUtxo` |
| E2E-5.11 | SegWit UTXO handling | P2WPKH UTXO uses `witnessUtxo`; no raw tx fetch |
| E2E-5.12 | RBF sequence flag | `rbf=true` sets input sequence to `0x00000001`; `rbf=false` sets `0xffffffff` |
| E2E-5.13 | Custom outputs + ACTION | Custom payment outputs coexist with ACTION data outputs; change adjusted correctly |
| E2E-5.14 | Fee source: explicit | Providing `feePerKb` bypasses RPC fee estimation |
| E2E-5.15 | Fee source: RPC | Null `feePerKb` triggers `getFeePerKilobyte()` RPC call |

---

### Category E2E-6: Multi-Chain Validation

**Objective**: Verify encoding produces correct PSBTs for all three supported blockchains.

| ID | Scenario | Chain | Verification |
|---|---|---|---|
| E2E-6.1 | Bitcoin OP_RETURN | bitcoin-regtest | Valid PSBT, dust=546, correct address format |
| E2E-6.2 | Dogecoin OP_RETURN | dogecoin-regtest | Valid PSBT, dust=546, Dogecoin address prefix |
| E2E-6.3 | Litecoin OP_RETURN | litecoin-regtest | Valid PSBT, dust=5460, Litecoin address prefix |
| E2E-6.4 | Bitcoin P2SH | bitcoin-regtest | P2SH output, dust-compliant |
| E2E-6.5 | Dogecoin P2SH | dogecoin-regtest | P2SH address uses Dogecoin script hash prefix |
| E2E-6.6 | Litecoin P2SH | litecoin-regtest | P2SH output value >= 5460 (Litecoin dust) |
| E2E-6.7 | Bitcoin P2WSH | bitcoin-regtest | P2WSH witness output (bech32 required) |
| E2E-6.8 | Bitcoin MULTISIGN | bitcoin-regtest | Multisig output at 546 sats |
| E2E-6.9 | Litecoin MULTISIGN | litecoin-regtest | Multisig output at 5460 sats |
| E2E-6.10 | All 9 network configs | all | CryptoNetworks returns valid config with dustThreshold for each |

---

### Category E2E-7: Complex Parameter & Edge Case Handling

**Objective**: Validate encoding correctness for unusual but valid parameter combinations and boundary values.

| ID | Scenario | Verification |
|---|---|---|
| E2E-7.1 | TICK with special characters | `J-DOG_#1` in ISSUE survives encoding |
| E2E-7.2 | TICK by numeric ID | `^1234` caret prefix preserved in SEND |
| E2E-7.3 | Maximum-length TICK | TICK at protocol maximum length encoded correctly |
| E2E-7.4 | Zero amount | `SEND\|0\|TICK\|0\|<addr>` -- zero preserved, not dropped |
| E2E-7.5 | Large amount (big number) | Amount with 18+ decimal precision preserved |
| E2E-7.6 | Unicode in memo | Memo containing unicode characters survives UTF-8 encoding |
| E2E-7.7 | Pipe character in memo | Memo containing `\|` -- verify it doesn't corrupt field parsing |
| E2E-7.8 | Empty optional fields | ISSUE with empty optional fields (locks, callback) preserved as empty strings |
| E2E-7.9 | data + rawData dual parameter | Both data and rawData compiled into script and recoverable as two separate buffers |
| E2E-7.10 | DISPENSER with all fields | All 8 dispenser fields including optional trailing fields preserved |
| E2E-7.11 | ORDER with expiration=0 | Zero expiration (no expiry) preserved |
| E2E-7.12 | BATCH with 10+ actions | Large batch with many semicolon-separated actions; all preserved |
| E2E-7.13 | Custom dust parameter | Custom dust value used for MULTISIGN output but not fee floor |
| E2E-7.14 | ISSUE with all locks enabled | All lock fields set to '1'; all preserved in encoded output |

---

### Category E2E-8: Error Handling & Negative Tests

**Objective**: Verify the encoder rejects invalid inputs gracefully without producing malformed PSBTs.

| ID | Scenario | Expected Behavior |
|---|---|---|
| E2E-8.1 | No UTXOs available | Throws error: "no utxos were provided" |
| E2E-8.2 | RPC fee estimation failure | Throws with RPC error message propagated |
| E2E-8.3 | Legacy UTXO raw tx fetch failure | Throws with "Transaction not found" |
| E2E-8.4 | UtxoTracker unreachable | Throws ECONNREFUSED when utxos=null and tracker down |
| E2E-8.5 | Invalid network name | Throws TypeError during construction |
| E2E-8.6 | MULTISIGN without compressedPubKey | Throws when compressedPubKey is null |
| E2E-8.7 | Invalid pubkey address for P2SH | Throws on invalid base58 address |
| E2E-8.8 | No change address with surplus funds | Throws "burn satoshis" error |
| E2E-8.9 | Empty data string | Verify behavior: either throws or produces empty payload |
| E2E-8.10 | Null data parameter | Verify behavior: throws or handles gracefully |
| E2E-8.11 | Negative fee value | Verify behavior: does not produce negative-value outputs |
| E2E-8.12 | UTXO value insufficient for fee | Verify behavior: handles gracefully (may throw or use all UTXOs) |

---

### Category E2E-9: Round-Trip Verification (Encoder-Decoder Consistency)

**Objective**: Conceptually verify that a PSBT produced by the encoder can be decoded back to the original ACTION, ensuring cross-service contract alignment with `xchain-decoder`.

| ID | Scenario | Verification |
|---|---|---|
| E2E-9.1 | OP_RETURN SEND round-trip | Encode SEND -> extract OP_RETURN data -> deobfuscate -> strip XCHN magic -> decompile script -> assert exact ACTION string match |
| E2E-9.2 | P2SH ISSUE round-trip | Encode full ISSUE -> create tx1+tx2 -> extract redeemScript from tx2 -> deobfuscate -> verify all 25+ fields |
| E2E-9.3 | MULTISIGN round-trip | Encode data as MULTISIGN -> extract fake pubkeys -> reconstruct data -> deobfuscate -> verify original payload |
| E2E-9.4 | P2WSH FILE round-trip | Encode large file as P2WSH -> extract witnessScript -> deobfuscate -> verify file content byte-for-byte |
| E2E-9.5 | Multi-chunk reassembly | Encode data spanning multiple OP_RETURN outputs -> extract all chunks in order -> reassemble -> verify complete payload |
| E2E-9.6 | BATCH round-trip | Encode multi-action BATCH -> recover -> verify semicolon-separated actions intact |
| E2E-9.7 | Cross-chain decode match | Same ACTION encoded on BTC/DOGE/LTC produces different PSBTs but identical decoded payloads |

**Implementation Note**: These tests use the `deobfuscate.js` helper to simulate the decoder's extraction logic. For full cross-service validation, a future phase should invoke `xchain-decoder`'s actual parsing functions against the encoder's output.

---

### Category E2E-10: JSON-RPC API Layer (Tier 2)

**Objective**: Validate the API server correctly marshals JSON-RPC parameters and returns valid PSBT hex.

| ID | Scenario | Verification |
|---|---|---|
| E2E-10.1 | create_tx with all params | JSON-RPC call with full param set returns `{psbt: <hex>, encoding: <string>}` |
| E2E-10.2 | create_tx minimal params | Only required params; defaults applied correctly |
| E2E-10.3 | PSBT hex validity | Returned hex string can be parsed by `bitcoin.Psbt.fromHex()` |
| E2E-10.4 | Error response format | Invalid params return JSON-RPC error with meaningful message |
| E2E-10.5 | CORS headers present | Response includes Access-Control-Allow-Origin |
| E2E-10.6 | Concurrent requests | Multiple simultaneous create_tx calls don't interfere |

**Note**: These tests require the API server running (`npm run api`) and belong in Tier 2 (live environment).

---

## 4. Test Design Strategy

### 4.1 Test File Organization

```
test/
  e2e/
    action-pipeline.e2e.js        # E2E-1: All 19+ ACTION types full pipeline
    p2sh-p2wsh-sequence.e2e.js    # E2E-2: Two-transaction orchestration
    encoding-boundaries.e2e.js    # E2E-3: Format selection boundaries
    obfuscation-integrity.e2e.js  # E2E-4: AES-128-CTR round-trips
    utxo-fee-change.e2e.js        # E2E-5: Input selection & fee logic
    multi-chain.e2e.js            # E2E-6: BTC/DOGE/LTC validation
    edge-cases.e2e.js             # E2E-7: Complex parameters
    error-rejection.e2e.js        # E2E-8: Negative tests
    round-trip.e2e.js             # E2E-9: Encoder-decoder consistency
    api-layer.e2e.js              # E2E-10: JSON-RPC API (Tier 2 only)
  e2e/helpers/
    (reuse existing integration/helpers/)
```

### 4.2 Test Structure Pattern

Each E2E test should follow this structure:

```
1. ARRANGE: Build ACTION config via actionFactory; prepare UTXOs via utxoFactory
2. ACT:     Call createTransaction() (or JSON-RPC for Tier 2)
3. ASSERT:  Verify PSBT structure, encoding type, and payload fidelity
4. EXTRACT: For round-trip tests, deobfuscate and compare to original input
```

### 4.3 Assertion Focus Areas

For every PSBT produced, E2E tests should assert on:

1. **Return shape**: `{ psbt: Psbt, encoding: string }` with valid encoding enum
2. **PSBT validity**: `result.psbt instanceof bitcoin.Psbt` -- structurally valid
3. **Input count**: At least 1 input; all inputs have either `witnessUtxo` or `nonWitnessUtxo`
4. **Output structure**: Correct output types for the encoding (OP_RETURN at value=0, P2SH at value>=dust, etc.)
5. **Payload fidelity**: Deobfuscated data matches original ACTION string byte-for-byte
6. **Magic word**: First 4 bytes after deobfuscation = `XCHN`
7. **Fee sanity**: Implied fee (inputs - outputs) >= dustAmount and <= reasonable upper bound
8. **Change output**: Present when change address provided and surplus > dust

### 4.4 Mocking Strategy

**Mock these (external I/O):**
- `BlockchainConnector.getFeePerKilobyte()` -> return deterministic fee rate
- `BlockchainConnector.getTransactionHex()` -> return pre-built raw tx hex
- `BlockchainConnector.isRegtest()` -> return true
- `UtxoTracker.getUtxosFromAddress()` -> return fixture UTXOs

**Do NOT mock these (core pipeline):**
- `XChainEncoder.prepareData()` -- must test real format selection
- `XChainEncoder.obfuscate()` -- must test real AES-128-CTR
- `bitcoinjs-lib` PSBT construction -- must test real script compilation
- `CryptoNetworks` -- must test real network configs

### 4.5 Data-Driven Test Approach

Categories E2E-1, E2E-6, and E2E-7 are ideal for data-driven (parameterized) test patterns. Define arrays of test cases and iterate:

```
const cases = [
  { name: 'SEND v0', factory: () => makeSend(), expectedEncoding: 'OP_RETURN' },
  { name: 'ISSUE full', factory: () => makeIssueFull('TK'), expectedEncoding: 'P2SH' },
  ...
]

for (const { name, factory, expectedEncoding } of cases) {
  it(`${name}: full pipeline produces valid ${expectedEncoding} PSBT`, async () => { ... })
}
```

This pattern is already used in the existing `action-encoding.test.js` (lines 241-294) and should be extended for E2E scope.

---

## 5. Coverage Gap Analysis (vs. Existing Integration Tests)

The existing integration suite covers Categories A-H well. The E2E plan adds coverage for:

| Gap | Existing Coverage | E2E Addition |
|---|---|---|
| API layer parameter marshalling | Only `api.test.js` (3 tests, requires live node) | E2E-10: Comprehensive JSON-RPC validation |
| Full tx1->tx2 data fidelity | B-3 verifies script structure but not data recovery | E2E-2.3/2.6: Full deobfuscation from tx2 |
| SEND v2/v3 multi-token encoding | Not tested individually | E2E-1.4/1.5: Explicit multi-token verification |
| FILE encoding (both sizes) | Not tested in isolation | E2E-1.23/1.24: Small (P2SH) and large (P2WSH) files |
| Unicode/special char in payloads | Only TICK special chars (A-11) | E2E-7.6/7.7: Unicode memo, pipe char edge cases |
| Zero/extreme amounts | Not tested | E2E-7.4/7.5: Zero amount, big number precision |
| Empty/null data params | Not tested | E2E-8.9/8.10: Graceful handling |
| Cross-chain decode equivalence | Not tested | E2E-9.7: Same ACTION on 3 chains decodes identically |
| Concurrent API requests | Not tested | E2E-10.6: No state interference |
| All SEND versions (v0-v3) | v0 and v1 tested; v2/v3 only in parametric sweep | E2E-1.3/1.4/1.5: Dedicated per-version tests |

---

## 6. Priority & Execution Order

### Phase 1 (Highest Priority -- Core Pipeline)
1. **E2E-1**: All ACTION types through full pipeline (30 tests)
2. **E2E-9**: Round-trip verification (7 tests)
3. **E2E-2**: P2SH/P2WSH two-transaction orchestration (9 tests)

### Phase 2 (High Priority -- Robustness)
4. **E2E-3**: Encoding boundaries (9 tests)
5. **E2E-4**: Obfuscation integrity (7 tests)
6. **E2E-8**: Error handling (12 tests)

### Phase 3 (Medium Priority -- Breadth)
7. **E2E-5**: UTXO/fee integration (15 tests)
8. **E2E-6**: Multi-chain validation (10 tests)
9. **E2E-7**: Edge cases (14 tests)

### Phase 4 (Lower Priority -- API Layer)
10. **E2E-10**: JSON-RPC API (6 tests, Tier 2 only)

**Total estimated test count: ~119 E2E scenarios**

---

## 7. Success Criteria

The E2E test suite is considered complete when:

1. Every supported ACTION type (19+) has at least one full pipeline test producing a valid PSBT
2. Every encoding type (OP_RETURN, P2SH, P2WSH, MULTISIGN) has round-trip verification
3. The P2SH and P2WSH two-transaction sequences are validated end-to-end with data recovery
4. All three chains (BTC, DOGE, LTC) produce valid PSBTs with correct dust thresholds
5. Boundary conditions at encoding type transitions (76-byte threshold) are explicitly tested
6. Error paths produce meaningful messages without creating malformed PSBTs
7. All tests pass deterministically in CI without external dependencies (Tier 1)
