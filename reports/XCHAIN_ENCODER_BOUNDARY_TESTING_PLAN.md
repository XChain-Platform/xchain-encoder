# XChain Encoder Boundary Testing Plan

## 1. Objective

Verify the `xchain-encoder`'s behavior when processing ACTION data and encoding parameters at the extreme edges of their defined limits, ensuring predictable PSBT generation, correct data integrity, and graceful failure on invalid inputs. Boundary testing targets the gaps between existing unit and integration tests, which cover the "happy path" and basic error handling but do not systematically exercise parameter extremes.

---

## 2. Rationale

The encoder is the first component in the XChain data pipeline. Every ACTION that enters the blockchain passes through `createTransaction()`. Errors here propagate irreversibly: once a transaction is broadcast, it cannot be recalled. Boundary conditions matter because:

- **Numeric overflow/truncation**: JavaScript's `parseInt()` and floating-point arithmetic can silently produce wrong results at extremes (e.g., amounts > `Number.MAX_SAFE_INTEGER`, fee calculations that round to zero).
- **Buffer sizing**: The encoder splits data into fixed-size chunks. Off-by-one errors at chunk boundaries corrupt data or produce invalid scripts.
- **Script limits**: Bitcoin consensus rules impose hard limits on script sizes, stack element counts, and transaction weight. Exceeding these produces transactions that nodes reject.
- **Cross-parameter interactions**: Individually valid parameters can create invalid states when combined (e.g., custom dust + low fee rate + many outputs).

---

## 3. Target Parameters & Limits

### 3.1 Encoding Output Type Boundaries

These are the hard-coded constants in `XChainEncoder.js` that control data chunking:

| Constant | Value | Effective Data Capacity | Source |
|---|---|---|---|
| `OP_RETURN_SIZE` | 80 bytes | 76 bytes (80 - 4 magic) | Line 33 |
| `P2SH_SIZE` | 520 bytes | 476 bytes (520 - 44 overhead) | Line 34 |
| `PW2SH_SIZE` | 10,000 bytes | 9,956 bytes (10000 - 44 overhead) | Line 35 |
| `MULTISIGN_SIZE` | 71 bytes | 62 bytes (71 - 4 magic - 5 overhead) | Line 36 |

### 3.2 createTransaction() Parameters

| Parameter | Type | Boundary Concerns |
|---|---|---|
| `utxos` | Array | null, empty `[]`, single, very large arrays (1000+), duplicate entries |
| `pubkey` | String | Valid base58 address, invalid base58, bech32 address (not base58), empty string |
| `customOutputs` | Array | null, empty, single output, many outputs (100+), outputs with extreme values |
| `data` | String | Empty, 1 byte, exactly 76 bytes (OP_RETURN limit), 77 bytes, very large (>10KB) |
| `rawData` | String/null | null, empty string, large raw data (FILE action with multi-KB payload) |
| `fee` | Number/null | null (auto-calculate), 0, 1, `dustAmount` exactly, `Number.MAX_SAFE_INTEGER` |
| `replacebyfee` | Boolean | true, false, truthy/falsy non-boolean values |
| `encoding` | String/null | null (auto-select), each valid type, invalid string, empty string |
| `change` | String/null | null (no change), valid address, invalid address |
| `p2shHash`/`p2shHex` | String/null | null (tx1), valid hex, malformed hex, mismatched pair |
| `compressedPubKey` | String/null | null, valid 33-byte compressed key, invalid length, uncompressed key |
| `unconfirmed` | Boolean | true, false |
| `feePerKb` | Number/null | null (RPC), 0, negative, very small (0.00000001), very large (100.0) |
| `dust` | Number/null | null (network default), 0, 1, network dust exactly, very large |

### 3.3 ACTION Payload Parameters (Protocol Level)

| Parameter | Constraints | Boundary Values |
|---|---|---|
| TICK | 1-250 chars, restricted charset | 1 char, 250 chars, 251 chars, empty, reserved names (BTC/LTC/DOGE/XCHAIN), special chars at limits |
| AMOUNT | Numeric string | "0", "0.000000000000000001" (18 decimals), "1000000000000000000000" (max supply), negative, non-numeric |
| MAX_SUPPLY | Up to 1 sextillion | "0", "1000000000000000000000", "1000000000000000000001" (over max) |
| DECIMALS | 0-18 | 0, 18, 19 (over max) |
| DESCRIPTION | 250 chars max, no pipe/semicolon | Empty, 250 chars, 251 chars, contains `\|`, contains `;` |
| MEMO | 250 chars max, no pipe/semicolon | Same as DESCRIPTION |
| VERSION | Varies per ACTION | Min valid, max valid, one over max, negative, non-integer |
| EXPIRATION | Unix timestamp | 0, current time, far future (year 2100), negative |
| GAS_LIMIT | Positive integer | 0, 1, `MAX_SAFE_INTEGER` |
| CODE_ENCODING | Hex string up to 64KB | Empty hex, exactly 65536 bytes decoded, 65537 bytes |
| ACTION_INDEX | Sequential integer | 0, 1, `MAX_SAFE_INTEGER`, negative |
| FIAT_CODE | Enum of 10 values | Each valid code, invalid code, empty |
| Boolean fields (LOCK_*, BALANCES, etc.) | "0" or "1" | "0", "1", "2", empty, "true"/"false" |

---

## 4. Boundary Value Scenarios

### 4.1 OP_RETURN Encoding Boundary (76/77 Bytes)

The auto-selection threshold in `prepareData()` (line 74) is `data.length + magicWordBuffer.length <= OP_RETURN_SIZE`:

| Scenario | Input | Expected Result |
|---|---|---|
| BND-OR-01 | `data` compiled to exactly 76 bytes | OP_RETURN selected, single chunk, 80-byte output |
| BND-OR-02 | `data` compiled to 77 bytes | P2SH auto-selected |
| BND-OR-03 | `data` = empty buffer (0 bytes) | OP_RETURN selected, chunk = 4 bytes (magic only) |
| BND-OR-04 | `data` = 1 byte | OP_RETURN selected, chunk = 5 bytes |
| BND-OR-05 | Forced OP_RETURN with 200 bytes of data | 3 OP_RETURN outputs (200/76 = ceil 3), all data preserved |
| BND-OR-06 | Forced OP_RETURN with exactly 152 bytes (2 * 76) | Exactly 2 chunks, no partial third chunk |
| BND-OR-07 | Forced OP_RETURN with 153 bytes (2*76 + 1) | 3 chunks, third chunk = magic + 1 byte |

**Note**: Existing unit tests cover BND-OR-01 through BND-OR-03 for `prepareData()` in isolation. Boundary tests should verify these through the full `createTransaction()` pipeline, including obfuscation and PSBT construction.

### 4.2 P2SH Chunk Boundary (476 Bytes)

| Scenario | Input | Expected Result |
|---|---|---|
| BND-P2SH-01 | ACTION payload compiles to exactly 476 bytes | 1 P2SH output in tx1 |
| BND-P2SH-02 | ACTION payload compiles to 477 bytes | 2 P2SH outputs in tx1 |
| BND-P2SH-03 | ACTION payload compiles to exactly 952 bytes (2 * 476) | 2 P2SH outputs, no partial third |
| BND-P2SH-04 | Full ISSUE action with all 25+ fields populated, each at max length | Verify chunk count and data integrity through tx1 + tx2 round-trip |
| BND-P2SH-05 | Multiple P2SH outputs: verify each output value >= `dustAmount` | All P2SH output values >= 546 sats (BTC) or 5460 sats (LTC) |

### 4.3 P2WSH Chunk Boundary (9,956 Bytes)

| Scenario | Input | Expected Result |
|---|---|---|
| BND-P2WSH-01 | Payload exactly 9,956 bytes | 1 P2WSH output |
| BND-P2WSH-02 | Payload 9,957 bytes | 2 P2WSH outputs |
| BND-P2WSH-03 | Very large FILE action (e.g., 50KB image) | Multiple P2WSH chunks, all data preserved |
| BND-P2WSH-04 | P2WSH on Dogecoin network (no bech32 support) | Should fail gracefully or fall back |

### 4.4 MULTISIGN Chunk Boundary (62 Bytes)

| Scenario | Input | Expected Result |
|---|---|---|
| BND-MS-01 | Payload exactly 62 bytes | 1 multisig output |
| BND-MS-02 | Payload 63 bytes | 2 multisig outputs |
| BND-MS-03 | Data where obfuscated bytes produce invalid EC point (0x02 + data > curve order) | Verify behavior: silent corruption, exception, or graceful handling |
| BND-MS-04 | Data exactly 32 bytes | `dataToPubkey()` produces exactly 33-byte key, no zero-fill needed |
| BND-MS-05 | Data < 32 bytes (e.g., 1 byte) | `dataToPubkey()` zero-fills to 33 bytes correctly |
| BND-MS-06 | Data > 32 bytes (e.g., 33 bytes) | `dataToPubkey()` concatenates without fill, result > 33 bytes - verify bitcoinjs-lib accepts or rejects |

### 4.5 Fee Calculation Boundaries

| Scenario | Input | Expected Result |
|---|---|---|
| BND-FEE-01 | `feePerKb = 0` | Fee calculated as 0, floored to `dustAmount` |
| BND-FEE-02 | `feePerKb` = negative value | Undefined behavior - document and propose guard |
| BND-FEE-03 | `feePerKb` extremely large (100 BTC/kB) | Fee may exceed input value - verify behavior |
| BND-FEE-04 | `maxFeeRateKb` set, `feePerKb` exceeds cap | Fee clamped to `maxFeePerBytes` |
| BND-FEE-05 | `maxFeeRateKb = 0` | `maxFeePerBytes = 0`, all fees clamped to 0 then floored to dust |
| BND-FEE-06 | `fee` parameter = 0 | Explicit fee of 0, but dust floor applies - verify `estimatedFee` ends up as `dustAmount` |
| BND-FEE-07 | `fee` parameter = 1 | Below dust threshold - verify flooring behavior |
| BND-FEE-08 | `fee` parameter set AND `feePerKb` set | `fee` takes precedence (line 462-464), `feePerKb` only used for P2SH spending estimates |
| BND-FEE-09 | Computed fee > total UTXO input value | `changeSatoshis` goes negative - verify behavior (no change output, possible invalid tx) |
| BND-FEE-10 | `Math.trunc()` precision at `estimatedTxSize * feePerBytes * SATOSHI_UNIT` with large values | JavaScript floating-point: verify no precision loss causes fee underpayment |

### 4.6 UTXO Boundaries

| Scenario | Input | Expected Result |
|---|---|---|
| BND-UTXO-01 | Single UTXO with value = 1 satoshi | Likely insufficient for fee - verify error or behavior |
| BND-UTXO-02 | Single UTXO with value = `dustAmount` exactly | Covers fee floor but no change - verify no-change behavior |
| BND-UTXO-03 | 1000 UTXOs (stress test input loop) | All valid UTXOs processed, sorted correctly, only needed count consumed |
| BND-UTXO-04 | All UTXOs are unconfirmed, `unconfirmed=false` | All filtered out - should throw "no utxos" |
| BND-UTXO-05 | All UTXOs are duplicates of the same txid:vout | Deduplication leaves 1 UTXO |
| BND-UTXO-06 | UTXO with `value` as string vs integer | `parseInt()` on line 470 handles string, but verify edge cases ("0x1A", "1.5", "NaN") |
| BND-UTXO-07 | UTXO with `value = 0` | Sorted last, contributes nothing - verify loop terminates |
| BND-UTXO-08 | UTXO with `value = Number.MAX_SAFE_INTEGER` (9007199254740991) | Verify no overflow in `inputSatoshis` addition |
| BND-UTXO-09 | Mix of segwit and legacy UTXOs | Both types added correctly, fee estimation uses correct per-type sizes |

### 4.7 Custom Outputs Boundaries

| Scenario | Input | Expected Result |
|---|---|---|
| BND-CO-01 | `customOutputs = []` (empty array) | No custom outputs added, no effect |
| BND-CO-02 | Single custom output with `value = "0"` | `parseInt("0") = 0` - dust-violating output added |
| BND-CO-03 | Single custom output with `value = "1.5"` | `parseInt("1.5") = 1` - truncation, not rounding |
| BND-CO-04 | 100 custom outputs | 100 extra outputs added, `estimatedTxSize` increases by 4300 bytes |
| BND-CO-05 | Custom output with invalid address | `bitcoinjs-lib` should throw on `psbt.addOutput()` |
| BND-CO-06 | Total custom output values exceed UTXO inputs | `changeSatoshis` goes negative |

### 4.8 Change Address Boundaries

| Scenario | Input | Expected Result |
|---|---|---|
| BND-CHG-01 | `change = null`, UTXO input > fee | Throws "Transaction would burn X satoshis" |
| BND-CHG-02 | `change = null`, UTXO input = fee exactly | `changeSatoshis = 0`, no throw (0 is not > `dustAmount`), no change output |
| BND-CHG-03 | `change` provided, `changeSatoshis` = 1 (positive but below dust) | Change output added with value 1 - may be unspendable dust |
| BND-CHG-04 | `change` provided, `changeSatoshis` = 0 | No change output added (condition is `changeSatoshis > 0`) |
| BND-CHG-05 | `change` provided, `changeSatoshis` negative | No change output added - transaction underfunded, fee eats everything |

### 4.9 Obfuscation Boundaries

| Scenario | Input | Expected Result |
|---|---|---|
| BND-OBF-01 | TXID with all zeros (`"0000...0000"`) | `cipherKey = "0000000000000000"`, `iv = "0000000000000000"` - valid AES, but deterministic |
| BND-OBF-02 | TXID with all `f`s (`"ffff...ffff"`) | Valid AES parameters |
| BND-OBF-03 | TXID shorter than 32 hex chars | `substr(0,16)` and `substr(16,16)` produce truncated key/IV - undefined AES behavior |
| BND-OBF-04 | Empty data buffer | AES-128-CTR on empty buffer - returns empty buffer |
| BND-OBF-05 | Data = 1 byte | AES-CTR stream cipher on single byte - valid |
| BND-OBF-06 | Very large data (10KB+) | AES-CTR handles any length - verify no Node.js buffer limits hit |

### 4.10 ACTION Payload Encoding Extremes

| Scenario | Input | Expected Result |
|---|---|---|
| BND-ACT-01 | Minimal ISSUE: `"ISSUE\|0\|X"` (10 bytes) | Fits OP_RETURN comfortably |
| BND-ACT-02 | Maximum ISSUE with all 25+ fields at max length | 250-char TICK + 250-char DESCRIPTION + 250-char MEMO + all params = ~1KB+ payload, requires P2SH |
| BND-ACT-03 | SEND with 18-decimal amount: `"SEND\|0\|TOK\|0.000000000000000001\|addr"` | Verify string encoding preserves all 18 decimal places |
| BND-ACT-04 | SEND v2 multi-send with 100 recipients | Very large payload, multiple P2SH chunks required |
| BND-ACT-05 | BATCH with maximum allowed commands (many `;`-separated) | Payload size may exceed P2SH, requiring P2WSH |
| BND-ACT-06 | DEPLOY with 64KB hex code | Decoded = 65,536 bytes, hex string = 131,072 chars - tests P2WSH multi-chunk |
| BND-ACT-07 | FILE with large binary rawData | Both `data` (metadata) and `rawData` (file content) compiled together - verify `script.compile()` handles dual large buffers |
| BND-ACT-08 | ACTION string containing only pipe delimiters: `"\|\|\|\|\|"` | Valid encoding (encoder is payload-agnostic), but verify no splitting issues |
| BND-ACT-09 | ACTION string with UTF-8 multi-byte characters | `Buffer.from(data, 'utf8')` may produce more bytes than `data.length` chars - verify auto-selection threshold accounts for byte length, not char length |
| BND-ACT-10 | ACTION string with null bytes (`\x00`) embedded | Verify `script.compile()` does not truncate at null byte |

### 4.11 Network-Specific Boundaries

| Scenario | Input | Expected Result |
|---|---|---|
| BND-NET-01 | Bitcoin dust threshold (546 sats) | Minimum fee = 546 sats |
| BND-NET-02 | Litecoin dust threshold (5460 sats) | Minimum fee = 5460 sats, 10x higher |
| BND-NET-03 | Dogecoin dust threshold (546 sats) | Same as Bitcoin |
| BND-NET-04 | P2WSH on Dogecoin (no `bech32` in network config) | `bitcoin.payments.p2wsh()` may throw - verify behavior |
| BND-NET-05 | Litecoin bech32 prefix (`ltc`/`tltc`/`rltc`) | Verify P2WSH addresses generated with correct prefix |
| BND-NET-06 | Invalid network string (e.g., `"ethereum-mainnet"`) | Constructor throws on `undefined.dustThreshold` |

### 4.12 P2SH Two-Transaction Pattern Boundaries

| Scenario | Input | Expected Result |
|---|---|---|
| BND-P2SH2TX-01 | tx2 with `p2shHex` that has 0 outputs | `p2shTx.outs[voutPsbtIndex]` throws index out of bounds |
| BND-P2SH2TX-02 | tx2 with `p2shHash` set but `p2shHex` = null | For P2SH encoding: `p2shHex` is required for `nonWitnessUtxo` - should throw |
| BND-P2SH2TX-03 | tx2 with malformed `p2shHex` (not valid hex) | `bitcoin.Transaction.fromHex()` throws |
| BND-P2SH2TX-04 | tx2 with `p2shHash` that doesn't match `p2shHex` transaction ID | Input references wrong tx - would fail at broadcast, but verify PSBT builds |
| BND-P2SH2TX-05 | tx1 with many P2SH outputs (large multi-chunk payload), then tx2 consumes all | Verify `voutPsbtIndex` increments correctly for each chunk |

### 4.13 TxSizeEstimator Boundaries

| Scenario | Input | Expected Result |
|---|---|---|
| BND-TSE-01 | OP_RETURN data > 252 bytes (triggers multi-byte `scriptPubKey` size flag) | TODO comment on line 27 acknowledges imprecision - verify magnitude of error |
| BND-TSE-02 | Unknown script type (not P2WPKH, P2WSH, P2PKH, P2SH) | Falls through to 350-byte fallback |
| BND-TSE-03 | `estimateInputSize()` with UTXO missing both `witnessUtxo` and `nonWitnessUtxo` | Returns `null` - verify caller handles null (line 488: adds null to `estimatedTxSize`) |
| BND-TSE-04 | `estimateP2shInputWithRedeem()` with 476-byte redeem script | Returns 41 + 2 + 72 + 476 = 591 bytes |
| BND-TSE-05 | `estimateP2shInputWithRedeem()` with 0-byte redeem script | Returns 115 bytes (overhead only) |

---

## 5. Test Design Strategy

### 5.1 Test Structure

Each boundary test should follow this pattern:

1. **Arrange**: Construct the specific boundary input (ACTION string, UTXO set, parameter values)
2. **Act**: Call `createTransaction()` with the boundary input
3. **Assert**: Verify one of:
   - **Valid boundary**: Correct PSBT structure, correct encoding type selected, data integrity preserved
   - **Invalid boundary**: Specific error thrown with meaningful message
   - **Edge boundary**: Behavior documented (e.g., change = 0 satoshis is silently dropped)

### 5.2 Simulating Boundary Conditions

**ACTION Payload Construction**: Build pipe-delimited strings directly, with specific parameters at their limits:
```
// Example: MAX_SUPPLY at exact maximum
data = "ISSUE|0|" + "A".repeat(250) + "|1000000000000000000000|..."
```

**UTXO Set Construction**: Use the existing `utxoFactory` helpers (from integration tests) to build synthetic UTXOs with exact values:
```
// UTXO with value exactly equal to dust threshold
makeSegwitUtxo(TXID_A, 0, 546)
```

**Fee Manipulation**: Pass explicit `feePerKb` and `fee` values to bypass RPC:
```
// Force fee calculation to produce sub-dust result
feePerKb = 0.0000001
```

**Encoding Override**: Force specific encoding types to test chunk boundaries independent of auto-selection:
```
encoding = "OP_RETURN" // even with data > 76 bytes
```

### 5.3 Expected Outcomes Matrix

| Input Class | Valid Boundary | Invalid Boundary |
|---|---|---|
| Data size at encoding limit | Correct encoding selected, single chunk | Falls to next encoding type |
| Fee at dust floor | Fee = `dustAmount` | Fee < dust but floored |
| UTXO value at minimum | Transaction builds but no change | Insufficient funds error or underfunded tx |
| Custom output count at extreme | All outputs added to PSBT | Node rejection (too many outputs) |
| String parameter at max length | Encoded correctly in payload | Exceeds encoding capacity, bumps encoding type |

### 5.4 Cross-Parameter Interaction Tests

These combinations create emergent boundary conditions:

| Combination | Risk |
|---|---|
| Large data + forced OP_RETURN + small UTXO | Many OP_RETURN outputs consume estimated tx size, fee may exceed inputs |
| P2SH encoding + custom dust = 1 + low fee rate | P2SH output values set to 1 sat, likely unspendable |
| MULTISIGN + data that obfuscates to invalid EC points | `bitcoin.payments.p2ms()` may throw or produce invalid script |
| Multi-chunk P2SH tx1 + tx2 with wrong `p2shHex` | Input/output mismatch in tx2 |
| Empty `data` + non-null `rawData` | `script.compile([emptyBuf, rawDataBuf])` - verify compiled output |
| `feePerKb = 0` + `maxFeeRateKb = 0` + `fee = null` | Both fee paths produce 0, floored to dust - verify consistency |
| 1000 UTXOs all duplicates + `unconfirmed=false` + all mempool | Dedup to 1, then filtered out - "no utxos" error |
| Litecoin network + P2WSH encoding | Uses `rltc`/`tltc`/`ltc` bech32 prefix - verify address generation |

---

## 6. Priority Classification

### P0 - Critical (Data Integrity / Transaction Validity)

- BND-OR-01 through BND-OR-07 (encoding type auto-selection boundaries)
- BND-P2SH-01, BND-P2SH-02 (P2SH chunk splitting)
- BND-FEE-09 (fee > inputs)
- BND-FEE-10 (floating-point precision)
- BND-CHG-01, BND-CHG-05 (change address missing / negative change)
- BND-ACT-09 (UTF-8 multi-byte)
- BND-ACT-10 (null bytes)
- BND-MS-03 (invalid EC points)
- BND-TSE-03 (null return from estimator)

### P1 - High (Robustness / Edge Cases)

- BND-UTXO-06 (string value parsing)
- BND-UTXO-08 (MAX_SAFE_INTEGER overflow)
- BND-CO-03 (parseInt truncation)
- BND-P2SH2TX-01 through BND-P2SH2TX-05 (two-tx pattern)
- BND-P2WSH-04 (Dogecoin + P2WSH)
- BND-OBF-03 (short TXID)

### P2 - Medium (Stress / Unusual Inputs)

- BND-UTXO-03 (1000 UTXOs)
- BND-CO-04 (100 custom outputs)
- BND-ACT-04 (100 recipients)
- BND-ACT-06 (64KB deploy code)
- BND-FEE-02 (negative fee rate)
- BND-NET-04, BND-NET-05 (network-specific P2WSH)

### P3 - Low (Documentation / Defense-in-Depth)

- BND-OBF-01, BND-OBF-02 (degenerate TXIDs)
- BND-FEE-05 (zero maxFeeRateKb)
- BND-TSE-01 (252-byte scriptPubKey imprecision)
- BND-ACT-08 (pipe-only payloads)

---

## 7. Gaps Identified in Existing Test Coverage

The current test suite (unit + integration) covers:

- **Covered**: Auto-selection threshold (76/77 bytes), chunk splitting for all 4 types, UTXO dedup/sorting/filtering, fee floor, fee cap, error propagation, custom dust, RBF sequencing, change address requirement
- **NOT covered (boundary-specific)**:
  1. Full `createTransaction()` pipeline at exact chunk boundaries (only `prepareData()` tested in isolation)
  2. JavaScript numeric precision at extremes (`Number.MAX_SAFE_INTEGER`, floating-point fee math)
  3. UTF-8 multi-byte character handling in ACTION strings
  4. Null bytes in data
  5. MULTISIGN with data that produces invalid EC curve points
  6. P2WSH on non-bech32 networks (Dogecoin)
  7. Two-transaction P2SH/P2WSH pattern with malformed tx1 inputs
  8. `TxSizeEstimator.estimateInputSize()` returning null and its effect on fee calculation
  9. `customOutputs` with non-integer string values (parseInt truncation)
  10. Negative `changeSatoshis` scenario (fee + outputs > inputs)
  11. Cross-parameter interaction tests (combinations listed in Section 5.4)
  12. `parseInt(utxo.value)` with non-standard string inputs

---

## 8. Recommendations

1. **Add input validation at `createTransaction()` entry**: The function currently accepts any value for `fee`, `feePerKb`, `dust`, and UTXO `value` without guards. Negative values, NaN, and non-numeric strings silently produce wrong results. Type-checking these parameters would convert many boundary conditions from "undefined behavior" to "clear error."

2. **Guard against `null` from `TxSizeEstimator.estimateInputSize()`**: When neither `witnessUtxo` nor `nonWitnessUtxo` is present, the estimator returns `null`. The caller adds this to `estimatedTxSize` (line 488/500). In JavaScript, `null` coerces to `0`, so the input silently contributes zero bytes to the fee estimate, causing fee underestimation.

3. **Document P2WSH network requirements**: P2WSH requires a `bech32` prefix in the network config. Dogecoin configs lack this. The behavior should be a clear error, not a cryptic `bitcoinjs-lib` exception.

4. **Test `parseInt()` on `customOutputs[].value`**: The current code does `parseInt(output.value)` which silently truncates decimals and returns `NaN` for non-numeric strings. Consider `Math.round()` or validation.

5. **Verify `dataToPubkey()` with data > 32 bytes**: The MULTISIGN path slices obfuscated data at byte 32. If the slice produces data exactly 32 bytes, no fill is needed. If < 32, it zero-fills. But the function does not guard against > 32 bytes, which would produce a > 33-byte "pubkey" - possibly rejected by `p2ms()`.

---

## 9. Implementation Results

Boundary tests were implemented in `test/boundary/` (8 files, 95 tests). All pass. Three significant bugs were discovered:

### Bug 1: MULTISIGN chunk size constant is too large (Severity: High)

`MULTISIGN_SIZE` is 71, giving a chunk data capacity of 62 bytes. However, `dataToPubkey()` can only handle slices of <= 32 bytes. The obfuscated chunk (magic + data) is split at byte 32 into two fake pubkeys. When the chunk exceeds 64 bytes (data > 60 compiled bytes), the second slice exceeds 32 bytes, producing a > 33-byte "pubkey" that `bitcoin.payments.p2ms()` rejects.

**Actual safe limit**: compiled data <= 60 bytes (59-char ASCII string). Data of 60+ chars throws `Expected property "pubkeys.1" of type isPoint`.

**Fix**: Reduce `MULTISIGN_SIZE` from 71 to 68 (giving chunk capacity 59, which after magic produces 63-byte chunks → 31-byte pk2 slices with 1 byte headroom), or add a guard in `dataToPubkey()` to reject data > 32 bytes.

### Bug 2: PW2SH_SIZE exceeds bitcoinjs-lib's hard limit (Severity: High)

`PW2SH_SIZE` is 10,000, giving a chunk capacity of 9,956 bytes. However, `bitcoinjs-lib` (v6.x) enforces a 3,600-byte maximum on P2WSH redeem scripts (`p2wsh.js:177`). The compiled redeem script includes the data chunk plus ~29 bytes of opcodes, so the actual maximum data per chunk through the encoder is ~3,571 bytes.

**Actual limit through full pipeline**: 3,568-char ASCII string. Data of 3,569+ chars throws `Redeem.output unspendable if larger than 3600 bytes`.

**Fix**: Reduce `PW2SH_SIZE` to a value compatible with bitcoinjs-lib (e.g., 3615, giving ~3,571 bytes of data capacity), or split into multiple chunks that each stay under 3,600 bytes.

### Bug 3: TxSizeEstimator null return silently underestimates fees (Severity: Medium)

`estimateInputSize()` returns `null` when a UTXO has neither `witnessUtxo` nor `nonWitnessUtxo`. In JavaScript, `null + number = number` (null coerces to 0), so the input contributes 0 bytes to the fee estimation instead of causing a visible error. This silently underestimates the transaction fee.

**Fix**: Return a conservative fallback (e.g., 350 bytes) instead of `null`, or throw an error.

### Additional Findings

- **`parseInt` truncation on custom output values**: `parseInt("1.5")` silently truncates to `1`. This affects both the output value and the UTXO selection logic.
- **Negative `changeSatoshis` is silently accepted**: When fee + outputs exceed inputs, the PSBT is created with under-funded inputs. No error is thrown.
- **P2WSH on Dogecoin throws cryptically**: The error message (`TypeError` from bitcoinjs-lib internals) doesn't indicate the root cause (missing `bech32` in network config).
- **`Number.MAX_SAFE_INTEGER` as UTXO value**: bitcoinjs-lib rejects change output values exceeding its `Satoshi` type limit (~2.1 trillion sats / 21M BTC).

### Test Coverage Summary

| File | Tests | Category |
|---|---|---|
| `encoding-chunk-boundaries.test.js` | 19 | Encoding type boundaries, chunk splitting, dataToPubkey |
| `fee-calculation-boundaries.test.js` | 12 | Fee floor, cap, truncation, negative, explicit override |
| `change-address-boundaries.test.js` | 11 | Change logic, dust threshold, negative change |
| `utxo-value-boundaries.test.js` | 11 | Value extremes, string coercion, dedup, sorting |
| `custom-output-boundaries.test.js` | 9 | parseInt truncation, many outputs, value extremes |
| `data-payload-boundaries.test.js` | 10 | UTF-8, null bytes, rawData, empty data, large payloads |
| `obfuscation-boundaries.test.js` | 10 | Degenerate TXIDs, short TXID, empty/large data |
| `txsize-estimator-boundaries.test.js` | 13 | Known imprecision, null return, fallback behavior |
| **Total** | **95** | |

Run with: `npm run test:boundary`
