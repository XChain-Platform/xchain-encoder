# XChain Encoder Security Audit Plan

**Component:** xchain-encoder v1.0.0  
**Date:** 2026-04-02  
**Auditor Role:** Senior Security Auditor & Backend Developer  
**Criticality:** HIGH — errors in encoding or input handling can lead to invalid transactions, loss of funds, or platform exploits

---

## Table of Contents

1. [Audit Scope](#1-audit-scope)
2. [Audit Methodology](#2-audit-methodology)
3. [Findings Summary](#3-findings-summary)
4. [Detailed Findings](#4-detailed-findings)
   - [4.1 API-Level Security](#41-api-level-security)
   - [4.2 Input Validation & Sanitization](#42-input-validation--sanitization)
   - [4.3 ACTION Format & Encoding Logic](#43-action-format--encoding-logic)
   - [4.4 PSBT Construction Integrity](#44-psbt-construction-integrity)
   - [4.5 Fee Calculation & Integer Math](#45-fee-calculation--integer-math)
   - [4.6 Obfuscation & Cryptographic Concerns](#46-obfuscation--cryptographic-concerns)
   - [4.7 UTXO Handling](#47-utxo-handling)
   - [4.8 Error Handling & Information Leakage](#48-error-handling--information-leakage)
   - [4.9 Dependency Security](#49-dependency-security)
   - [4.10 Network & Cross-Chain Risks](#410-network--cross-chain-risks)
5. [Prioritized Risk Register](#5-prioritized-risk-register)
6. [Mitigation Recommendations](#6-mitigation-recommendations)

---

## 1. Audit Scope

### In Scope

| Area | Files | Focus |
|------|-------|-------|
| API endpoint security | `src/api.js` | Auth, CORS, rate limiting, body validation |
| Core encoding pipeline | `src/XChainEncoder.js` | Input validation, PSBT construction, fee calculation, data chunking |
| Obfuscation layer | `src/XChainEncoder.js` (obfuscate/dataToPubkey) | AES-128-CTR key/IV derivation, fake pubkey generation |
| Blockchain connector | `src/BlockchainConnector.js` | RPC credential handling, error leakage |
| UTXO tracker client | `src/UtxoTracker.js` | Trust boundary, response validation |
| Network configuration | `src/CryptoNetworks.js` | Network param correctness, cross-chain risks |
| Fee estimation | `src/TxSizeEstimator.js` | Size estimation accuracy, fallback safety |
| Dependencies | `package.json`, `package-lock.json` | Known CVEs, deprecated packages |

### Out of Scope

- Decoder/indexer ACTION processing logic
- Coin daemon (bitcoind/litecoind/dogecoind) security
- xchain-utxo-tracker internal security (treated as an external trust boundary)
- Browser bundle runtime environment
- Deployment infrastructure (Docker, networking)

---

## 2. Audit Methodology

### 2.1 Approach: Data Flow Tracing

The primary methodology traces data from API ingress through to PSBT output, identifying trust boundaries and validation gaps at each stage:

```
API Request (JSON-RPC body)
    ↓  [Trust Boundary 1: No auth, no input validation]
XChainEncoder.createTransaction()
    ↓  [Trust Boundary 2: UTXO data from tracker/caller]
prepareData() → data chunking by encoding type
    ↓  [Trust Boundary 3: Data embedded in scripts]
obfuscate() → AES-128-CTR with TXID-derived key
    ↓
PSBT construction (bitcoinjs-lib)
    ↓  [Trust Boundary 4: Fee calculation with floating-point]
UTXO selection loop → change calculation
    ↓
Return { psbt, encode_type }
```

### 2.2 Review Steps

1. **API boundary audit** — Examine all parameters accepted by the JSON-RPC endpoint. Check for authentication, rate limiting, body size limits, and type validation before values enter the encoding pipeline.

2. **Parameter validation audit** — For each parameter accepted by `createTransaction()` (`data`, `rawData`, `pubkey`, `utxos`, `customOutputs`, `fee`, `feePerKb`, `dust`, `encoding`, `change`, `p2shHash`, `p2shHex`, `compressedPubKey`, `rbf`, `unconfirmed`), verify: type checking, range validation, format validation, and behavior when missing/null/undefined.

3. **Encoding logic audit** — Trace each encoding path (OP_RETURN, P2SH, P2WSH, MULTISIGN) through `prepareData()` and the PSBT construction loop. Verify chunk boundary math, magic word handling, and script compilation safety.

4. **PSBT construction audit** — Review all calls to `bitcoinjs-lib` APIs (`psbt.addInput`, `psbt.addOutput`, `bitcoin.payments.*`, `bitcoin.script.compile`). Verify inputs are validated before library calls and that library exceptions are caught.

5. **Fee and math audit** — Trace all satoshi arithmetic for floating-point corruption, NaN propagation, and integer overflow. Review `parseInt` calls for missing radix and NaN guards.

6. **Cryptographic audit** — Evaluate the AES-128-CTR obfuscation scheme for key/IV reuse, entropy, and the security properties it actually provides vs. what might be assumed.

7. **Error handling audit** — Search for unhandled exceptions, raw library errors propagating to callers, and error messages that leak internal state.

8. **Dependency audit** — Run `npm audit`, review pinned versions of crypto-critical packages, and identify deprecated transitive dependencies.

---

## 3. Findings Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| **CRITICAL** | 5 | No API authentication, NaN propagation corrupting transactions, no input validation at API boundary, fee bypass, unlimited payload size |
| **HIGH** | 8 | Missing parameter validation (pubkey, encoding, customOutputs, UTXOs), p2shHash/p2shHex mismatch, unhandled exceptions leaking internals, deprecated dependency chain |
| **MEDIUM** | 9 | AES key reuse, wildcard CORS, no rate limiting, cross-chain ACTION restrictions not enforced, Dogecoin P2WSH misconfiguration, fee floating-point errors |
| **LOW** | 7 | Buffer.allocUnsafe usage, dataToPubkey invalid EC points, MULTISIGN size discrepancy, dogecoin regtest/testnet identical params, getFirstBlock stub |

**Total: 29 findings across 10 categories**

---

## 4. Detailed Findings

### 4.1 API-Level Security

#### SEC-API-01: No Authentication on JSON-RPC Endpoint [CRITICAL]
- **File:** `src/api.js:51-85`  
- **Finding:** The `/api` endpoint has zero authentication. No API key, JWT, IP allowlist, or any middleware gates access. Any host that can reach the port can call `create_tx` and instruct the encoder to construct arbitrary transactions.  
- **Impact:** Unauthorized transaction construction; potential fund theft if signing is automated downstream.

#### SEC-API-02: Wildcard CORS Policy [MEDIUM]
- **File:** `src/api.js:57`  
- **Finding:** `app.use(cors())` with no options sets `Access-Control-Allow-Origin: *`. In browser deployments, any origin can make requests to the encoder API.  
- **Impact:** Cross-origin transaction construction requests from malicious websites.

#### SEC-API-03: No Rate Limiting [MEDIUM]
- **File:** `src/api.js`  
- **Finding:** No rate-limiting middleware exists. Unbounded `create_tx` requests trigger upstream RPC calls to the coin node and UTXO tracker.  
- **Impact:** Denial-of-service against the encoder and connected coin node; fee-estimation abuse through rapid sequential requests.

#### SEC-API-04: No Request Body Size or Depth Limit [HIGH]
- **File:** `src/api.js:54`  
- **Finding:** `bodyParser.json()` uses the default 100KB limit but no validation of array depth or size. A `utxos` array with thousands of entries triggers an RPC call per entry.  
- **Impact:** Resource exhaustion via large UTXO arrays or deeply nested custom output structures.

#### SEC-API-05: All Parameters Passed Through Without Validation [CRITICAL]
- **File:** `src/api.js:66-81`  
- **Finding:** Every parameter from the JSON-RPC body is forwarded directly to `encoder.createTransaction()` with no type checking, range validation, or sanitization at the API boundary.  
- **Impact:** All downstream validation gaps (SEC-INPUT-01 through SEC-INPUT-10) are directly exploitable via the API.

---

### 4.2 Input Validation & Sanitization

#### SEC-INPUT-01: `data` and `rawData` Not Validated [HIGH]
- **File:** `src/XChainEncoder.js:216-224`  
- **Finding:** `data` is converted via `Buffer.from(data, 'utf8')` with no type check, length limit, or content validation. Non-string types, null bytes, and arbitrarily large payloads are accepted. A very large string produces unbounded chunk iteration and potentially hundreds of PSBT outputs.  
- **Impact:** Memory exhaustion; transactions exceeding node policy limits; unlimited fee burn.

#### SEC-INPUT-02: `pubkey` Not Validated Before Base58Check Decode [HIGH]
- **File:** `src/XChainEncoder.js:124`  
- **Finding:** `bitcoin.address.fromBase58Check(pubkey)` is called without pre-validation. Invalid Base58Check strings cause bitcoinjs-lib to throw raw exceptions that propagate to the API caller.  
- **Impact:** Information leakage via library error messages; unhandled crash if exception is not caught by the RPC framework.

#### SEC-INPUT-03: `compressedPubKey` Used Without Format Validation [HIGH]
- **File:** `src/XChainEncoder.js:418`  
- **Finding:** `Buffer.from(compressedPubKey, "hex")` is called with no length check (must be 33 bytes) or prefix check (must start with `02` or `03`). A malformed buffer may produce an invalid multisig script that bitcoinjs-lib silently accepts.  
- **Impact:** Malformed MULTISIGN transactions; potential fund loss if the multisig output becomes unspendable.

#### SEC-INPUT-04: `encoding` Not Validated Against Allowed Enum [HIGH]
- **File:** `src/XChainEncoder.js:70-172`  
- **Finding:** `prepareData()` has no `default` case in its `switch`. Unrecognized `encoding` values cause `prepareData` to return `null`. The caller at line 276 then dereferences `preparedData["dataBufferArray"]` on `null`, causing an uncaught `TypeError`.  
- **Impact:** Unhandled crash; error message leaks internal code structure.

#### SEC-INPUT-05: `customOutputs` Entries Not Validated [CRITICAL]
- **File:** `src/XChainEncoder.js:447-456`  
- **Finding:** `output.address` is passed to `psbt.addOutput()` without address format validation. `parseInt(output.value)` has no NaN guard — if `value` is non-numeric, `NaN` propagates through all subsequent arithmetic (`outputSatoshis`, `changeSatoshis`), silently corrupting the entire fee and change calculation.  
- **Impact:** Silent transaction corruption; all change burned as fees (loss of funds); cross-network address injection.

#### SEC-INPUT-06: `fee` Parameter Accepts Any Value [HIGH]
- **File:** `src/XChainEncoder.js:463`  
- **Finding:** The explicit `fee` parameter bypasses the `maxFeePerBytes` cap entirely. A caller can supply `fee: 0` (stuck transaction), a negative number, or `NaN`. The dust floor check at line 517 does not catch `NaN` because `NaN < dustAmount` evaluates to `false`.  
- **Impact:** Fee manipulation — either zero-fee stuck transactions or excessive fees draining the wallet.

#### SEC-INPUT-07: `dust` Parameter Not Range-Checked [MEDIUM]
- **File:** `src/XChainEncoder.js:211-213`  
- **Finding:** `finalDust = dust` when truthy, with no type or range check. An astronomically large `dust` value forces all P2SH and MULTISIGN outputs to carry that amount, draining the sender. A `dust: 0` value is falsy and ignored (not applied), which is inconsistent.  
- **Impact:** Fund drain via inflated output values; inconsistent behavior at zero.

#### SEC-INPUT-08: `feePerKb` Accepts Unbounded Values [MEDIUM]
- **File:** `src/XChainEncoder.js:202-203`  
- **Finding:** `feePerBytes = feePerKb/1000` with no minimum or maximum. If `MAX_FEE_RATE_KB` is not configured at startup, the caller can supply `feePerKb: 0.000001` (stuck) or `feePerKb: 99999999` (drain).  
- **Impact:** Fee manipulation via uncapped fee rate parameter.

#### SEC-INPUT-09: `p2shHex` Not Validated [HIGH]
- **File:** `src/XChainEncoder.js:305, 364`  
- **Finding:** `Buffer.from(p2shHex, 'hex')` and `bitcoin.Transaction.fromHex(p2shHex)` called without format validation. Malformed hex produces truncated buffers or assertion failures with internal messages.  
- **Impact:** Crash; information leakage through library assertion messages.

#### SEC-INPUT-10: `utxos` Array Entries Not Structurally Validated [HIGH]
- **File:** `src/XChainEncoder.js:243-268`  
- **Finding:** UTXO entries are iterated assuming `txid`, `vout`, `confirmations`, `value`, and `scriptPubKey` fields exist and are the correct type. Missing `scriptPubKey` causes `Buffer.from(undefined, 'hex')` producing an empty buffer. Missing `txid` causes `undefined` as a PSBT input hash.  
- **Impact:** Malformed PSBTs; silent data corruption; potential crash.

---

### 4.3 ACTION Format & Encoding Logic

#### SEC-ACTION-01: No ACTION Parameter Validation [CRITICAL]
- **File:** `src/XChainEncoder.js:216`  
- **Finding:** The encoder treats `data` as an opaque byte string. It never parses or validates the pipe-delimited ACTION format, VERSION field, required field count, field types, or reserved-character restrictions (pipes `|` in MEMO, semicolons `;` in BATCH sub-commands). Any byte sequence is encoded into a valid PSBT.  
- **Impact:** Syntactically invalid ACTIONs produce valid blockchain transactions that burn fees but are rejected by the indexer. Embedded pipe characters in freeform fields cause field-count drift in the decoder. BATCH payloads with embedded semicolons in MEMO fields could inject phantom sub-commands.

#### SEC-ACTION-02: Cross-Chain ACTION Restrictions Not Enforced [MEDIUM]
- **File:** `src/XChainEncoder.js`  
- **Finding:** STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION, and CLAIM_REWARDS are protocol-restricted to BTC only. The encoder is configured with a `NETWORK` env var but never checks whether the ACTION type is legal for the configured network.  
- **Impact:** Valid Dogecoin/Litecoin transactions carrying BTC-only ACTIONs; fees burned, decoder DB polluted with failed actions.

#### SEC-ACTION-03: VERSION Field Never Parsed or Validated [HIGH]
- **File:** `src/XChainEncoder.js:216`  
- **Finding:** Each ACTION type has version-specific field layouts (e.g., SEND v0 vs v2 have different field counts and meanings). The encoder never reads VERSION. A version-0 SEND with a version-2 layout will encode into a valid transaction carrying corrupt ACTION data.  
- **Impact:** Silent data corruption; indexer rejection or misparse of ACTION fields.

#### SEC-ACTION-04: No Maximum Payload Size Guard [CRITICAL]
- **File:** `src/XChainEncoder.js:80-169`  
- **Finding:** No upper bound on encoded data size. Megabytes of data submitted for P2WSH encoding (3615 bytes/chunk) produce an unbounded number of outputs in a single PSBT. The UTXO selection loop then tries to fund all outputs. This can exhaust memory and produce PSBTs that exceed node mempool policy limits.  
- **Impact:** Memory exhaustion DoS; stuck oversized transactions; unlimited fee burn.

---

### 4.4 PSBT Construction Integrity

#### SEC-PSBT-01: P2WSH Path Missing Bounds Check on `p2shTx.outs` [HIGH]
- **File:** `src/XChainEncoder.js:393-397`  
- **Finding:** `p2shTx["outs"][voutPsbtIndex]` is accessed without checking that the index exists. If `p2shHex` has fewer outputs than expected data chunks, dereferencing `undefined["script"]` throws an uncaught `TypeError`.  
- **Impact:** Crash; error message leaks PSBT construction internals.

#### SEC-PSBT-02: NaN `changeSatoshis` Silently Burns All Change as Fees [CRITICAL]
- **File:** `src/XChainEncoder.js:527-531`  
- **Finding:** Change output is added only when `changeSatoshis > 0`. If any satoshi calculation was corrupted by NaN (from SEC-INPUT-05, SEC-INPUT-10), then `NaN > 0` is `false` — no change output is added and no error is thrown. The transaction silently assigns all unallocated input value to miner fees.  
- **Impact:** Complete loss of change funds; silent, undetectable by the caller.

#### SEC-PSBT-03: `p2shHash`/`p2shHex` Mismatch Not Detected [HIGH]
- **File:** `src/XChainEncoder.js:304-306`  
- **Finding:** If `p2shHex` represents a different transaction than `p2shHash`, the PSBT references `p2shHash` as the input TXID but uses the wrong redeem script and witness data from `p2shHex`. No cross-validation (`p2shTx.getId() === p2shHash`) is performed.  
- **Impact:** Unbroadcastable or malformed transactions; potential fund lock in P2SH outputs that can never be spent.

#### SEC-PSBT-04: Negative `changeSatoshis` Not Detected [MEDIUM]
- **File:** `src/XChainEncoder.js:466-531`  
- **Finding:** If all UTXOs are exhausted without covering `outputSatoshis + estimatedFee`, `changeSatoshis` becomes negative. Since `negative > 0` is `false`, no change output is added and no error is thrown. The PSBT has inputs that do not cover outputs + fees.  
- **Impact:** Invalid transaction that will be rejected by the network; caller receives no error feedback.

---

### 4.5 Fee Calculation & Integer Math

#### SEC-FEE-01: Floating-Point Multiplication in Satoshi Arithmetic [MEDIUM]
- **File:** `src/XChainEncoder.js:505`  
- **Finding:** `estimatedFee = Math.trunc(estimatedTxSize * feePerBytes * SATOSHI_UNIT)` chains floating-point operations. `Math.trunc` always rounds down, systematically underestimating fees. For large transactions this can produce below-minimum-relay-fee results.  
- **Impact:** Stuck transactions due to fee underestimation on large payloads.

#### SEC-FEE-02: `parseInt` Without Radix on UTXO Values [MEDIUM]
- **File:** `src/XChainEncoder.js:470`  
- **Finding:** `parseInt(nextUtxo.value)` without explicit radix. Strings starting with `"0x"` are parsed as hexadecimal. A malicious UTXO tracker response could supply hex-encoded values that parse to unexpected amounts.  
- **Impact:** Incorrect UTXO value interpretation; fee miscalculation.

#### SEC-FEE-03: `parseInt(output.value)` NaN Propagation [CRITICAL]
- **File:** `src/XChainEncoder.js:451, 453`  
- **Finding:** No `isNaN()` guard after `parseInt`. A single non-numeric custom output value corrupts `outputSatoshis` to `NaN`, which cascades to `changeSatoshis = NaN`, triggering SEC-PSBT-02 (silent change burn).  
- **Impact:** Complete loss of change funds from a single malformed custom output.

#### SEC-FEE-04: Explicit `fee` Parameter Bypasses `MAX_FEE_RATE_KB` Cap [HIGH]
- **File:** `src/XChainEncoder.js:463`, `src/api.js:43`  
- **Finding:** The `maxFeePerBytes` cap only applies to the auto-estimated fee path. The explicit `fee` parameter is accepted verbatim with no upper bound.  
- **Impact:** Caller can set arbitrarily high fees, draining wallet funds to miner fees.

#### SEC-FEE-05: Fee Estimate Wrong for Large `rawData` (>252 bytes) [MEDIUM]
- **File:** `src/XChainEncoder.js:216-224`, `src/TxSizeEstimator.js`  
- **Finding:** `TxSizeEstimator.estimateOpReturnOutput` comment notes "this won't be precise if the scriptpubkey is greater than 252 bytes." Large `rawData` payloads via `bitcoin.script.compile` trigger `OP_PUSHDATA2` encoding (2-byte length prefix), but the size estimator does not account for this.  
- **Impact:** Fee underestimation on FILE actions or other large-data ACTIONs.

---

### 4.6 Obfuscation & Cryptographic Concerns

#### SEC-CRYPTO-01: AES Key and IV Derived from Same Public TXID [MEDIUM]
- **File:** `src/XChainEncoder.js:174-181`  
- **Finding:** The AES-128-CTR key is `txid.substr(0,16)` and IV is `txid.substr(16,16)` — both from the first input's TXID, which is public on the blockchain. Key and IV are not independent. Additionally, the "key" is 16 ASCII hex characters (effective entropy ~64 bits, not 128 bits).  
- **Impact:** No actual confidentiality. Anyone observing the blockchain can derive the key and deobfuscate the data. This is by design (obfuscation not encryption), but the security properties should be clearly documented so downstream consumers do not assume confidentiality.

#### SEC-CRYPTO-02: AES-CTR Keystream Reuse on Same First-Input TXID [MEDIUM]
- **File:** `src/XChainEncoder.js:174-181, 290`  
- **Finding:** If the same first-input TXID is reused across multiple `create_tx` calls (possible when the caller supplies UTXOs manually), the identical keystream is generated. XOR-recovery of plaintexts from two ciphertexts encrypted with the same CTR keystream is trivial.  
- **Impact:** Complete deobfuscation of both messages if an attacker observes two transactions sharing the same first input TXID.

#### SEC-CRYPTO-03: `dataToPubkey` Produces Invalid EC Points [LOW]
- **File:** `src/XChainEncoder.js:186-194`  
- **Finding:** Prepends `0x02` to arbitrary data and zero-pads to 33 bytes. The resulting value is not a valid secp256k1 compressed public key for most inputs. While bitcoinjs-lib accepts it in `p2ms` construction, wallet software or hardware signers that validate public keys against the curve will reject the transaction.  
- **Impact:** MULTISIGN-encoded transactions may be rejected by strict validators; known trade-off but undocumented as a compatibility risk.

#### SEC-CRYPTO-04: `Buffer.allocUnsafe` in `dataToPubkey` [LOW]
- **File:** `src/XChainEncoder.js:186-194`  
- **Finding:** `Buffer.allocUnsafe(32 - data.length)` is used for padding. The buffer is immediately filled with `0x00`, but if the fill ever fails partially (e.g., due to a future Node.js API change), uninitialized heap memory could leak into the transaction.  
- **Impact:** Low probability; potential information leakage of heap contents into broadcast transactions.

---

### 4.7 UTXO Handling

#### SEC-UTXO-01: UTXO Tracker Response Trusted Without Validation [HIGH]
- **File:** `src/UtxoTracker.js:56-62`, `src/XChainEncoder.js:234-238`  
- **Finding:** The response from the external xchain-utxo-tracker is used directly. No structural validation of UTXO objects. A compromised tracker could return manipulated `value`, incorrect `scriptPubKey`, or false `confirmations`.  
- **Impact:** Transaction construction based on falsified UTXO data; incorrect fee calculations; potential fund loss.

#### SEC-UTXO-02: UTXO Tracker Has No Authentication [MEDIUM]
- **File:** `src/UtxoTracker.js:41-46`  
- **Finding:** HTTP requests to the UTXO tracker include no authentication header. Any process on the network that can intercept or impersonate the tracker can inject malicious UTXO data.  
- **Impact:** Man-in-the-middle UTXO injection; transaction manipulation.

#### SEC-UTXO-03: `scriptPubKey` Not Validated Before Buffer Conversion [MEDIUM]
- **File:** `src/XChainEncoder.js:482`  
- **Finding:** `Buffer.from(utxo.scriptPubKey, 'hex')` called without checking the field is a non-empty, even-length hex string. Non-hex or odd-length values silently produce truncated or empty buffers.  
- **Impact:** Malformed witness scripts in PSBT inputs; potentially unspendable outputs.

#### SEC-UTXO-04: Caller Controls AES Key via UTXO Order [MEDIUM]
- **File:** `src/XChainEncoder.js:269`  
- **Finding:** `txidFirstInput = utxos[0]["txid"]` is set after sorting by value (largest first). A caller supplying UTXOs manually controls which TXID becomes the AES key/IV. Combined with SEC-CRYPTO-02, this enables chosen-key attacks on the obfuscation.  
- **Impact:** Attacker-controlled obfuscation key; complete control over the "encrypted" output.

#### SEC-UTXO-05: O(n^2) Deduplication Loop [LOW]
- **File:** `src/XChainEncoder.js:243-265`  
- **Finding:** Nested while loop with `splice` for deduplication. O(n^2) for large UTXO lists and mutates the array during iteration.  
- **Impact:** Denial-of-service via API with thousands of duplicate UTXOs.

---

### 4.8 Error Handling & Information Leakage

#### SEC-ERR-01: Raw Library Exceptions Propagate to API Callers [HIGH]
- **File:** `src/XChainEncoder.js` (throughout)  
- **Finding:** No `try/catch` blocks in `createTransaction`. All exceptions from bitcoinjs-lib (`psbt.addInput`, `psbt.addOutput`, `bitcoin.address.fromBase58Check`, `bitcoin.Transaction.fromHex`) propagate unhandled to `express-json-rpc-router`, which serializes them to the caller. Error messages may contain internal file paths, stack traces, or parameter values.  
- **Impact:** Information disclosure of internal architecture, library versions, and code paths.

#### SEC-ERR-02: `BlockchainConnector` Logs and Re-Throws Full Error Objects [MEDIUM]
- **File:** `src/BlockchainConnector.js:146-148`  
- **Finding:** `console.error('Error:', error.message)` followed by `throw error`. The original error object may contain the full HTTP response body from the coin daemon. While credentials are in headers (not URL), internal node addresses are leaked.  
- **Impact:** Information disclosure of internal infrastructure topology.

#### SEC-ERR-03: Change Amount Leaked in Error Message [LOW]
- **File:** `src/XChainEncoder.js:524`  
- **Finding:** `throw new Error(\`Transaction would burn ${changeSatoshis} satoshis as fees.\`)` reveals the exact change amount to the caller, disclosing how much the sender's wallet holds beyond the outputs.  
- **Impact:** Wallet balance information disclosure in multi-party or custodial deployments.

#### SEC-ERR-04: `CryptoNetworks` Crash on Unknown Network [LOW]
- **File:** `src/CryptoNetworks.js:26-109`  
- **Finding:** `getBitcoinJsNetwork` has no `default` case. An unrecognized `NETWORK` env var causes the constructor to dereference `undefined["dustThreshold"]`, crashing the entire API process at startup.  
- **Impact:** Denial-of-service via misconfiguration; no graceful error message.

---

### 4.9 Dependency Security

#### SEC-DEP-01: `bitcoin-core` Depends on Deprecated `request` Package [HIGH]
- **Vulnerability chain:** `bitcoin-core@4.2.0` -> `@uphold/request-logger@2.0.0` -> `request@2.88.2`  
- **CVEs via `request`:**
  - `form-data@2.3.3` — **CRITICAL**: Unsafe random boundary generation (GHSA-fjxv-7rqg-78g4)
  - `qs` (old) — **MODERATE**: arrayLimit bypass enables DoS via memory exhaustion (GHSA-6rw7-vpxm-498p)
  - `tough-cookie` (old) — **MODERATE**: Prototype pollution (GHSA-72xf-g2v4-qvf3)
- **Fix status:** No fix available — `request` is deprecated. Requires replacing `bitcoin-core` with a modern RPC client.

#### SEC-DEP-02: Browserify Chain Includes Vulnerable `elliptic` [MEDIUM]
- **Vulnerability chain:** `browserify@17.0.1` -> `crypto-browserify@3.12.1` -> `browserify-sign@4.2.5` -> `elliptic@6.6.1`  
- **CVE:** GHSA-848j-6mx2-7j84 — Risky cryptographic implementation  
- **Impact:** Affects the browser bundle only (`dist/xchain_encoder.min.js`). The Node.js API server uses built-in `crypto`, not `elliptic`.

#### SEC-DEP-03: Core Crypto Dependencies Are Current [INFORMATIONAL]
- `bitcoinjs-lib@6.1.7`, `tiny-secp256k1@2.2.4`, `ecpair@2.1.0`, `bip32@4.0.0`, `bip39@3.1.0` — all current with no known CVEs.
- `express@4.22.1`, `helmet@7.2.0`, `cors@2.8.6` — all current.

---

### 4.10 Network & Cross-Chain Risks

#### SEC-NET-01: Dogecoin Configs Missing `bech32` Field [MEDIUM]
- **File:** `src/CryptoNetworks.js:35-70`  
- **Finding:** `dogecoin-mainnet`, `dogecoin-testnet`, and `dogecoin-regtest` network objects lack a `bech32` field. P2WSH encoding on Dogecoin will cause bitcoinjs-lib to either throw or silently fall back to Bitcoin's bech32 HRP (`bc1`), producing invalid addresses.  
- **Impact:** P2WSH transactions on Dogecoin produce Bitcoin-format bech32 addresses; funds sent to these addresses are unrecoverable on Dogecoin.

#### SEC-NET-02: Dogecoin Regtest/Testnet Share Identical Network Params [LOW]
- **File:** `src/CryptoNetworks.js:47-70`  
- **Finding:** Both environments use `pubKeyHash: 0x71`, `scriptHash: 0xc4`, `wif: 0xf1`. Addresses are indistinguishable, preventing environment separation.  
- **Impact:** Accidental cross-environment transaction submission; no address-level safety net.

#### SEC-NET-03: P2WSH Chunk Size Hardcoded Against Library Limit [LOW]
- **File:** `src/XChainEncoder.js:33`  
- **Finding:** `PW2SH_SIZE = 3615` is derived from bitcoinjs-lib's internal 3600-byte redeem script limit, not Bitcoin consensus (10,000 bytes for witness scripts). If the library is upgraded and this limit changes, the constant silently becomes wrong.  
- **Impact:** Encoding failures or oversized scripts after library upgrades.

---

## 5. Prioritized Risk Register

### Priority 1 — CRITICAL (Address Immediately)

| ID | Finding | Impact | Effort |
|----|---------|--------|--------|
| SEC-API-01 | No API authentication | Unauthorized transaction construction | Medium |
| SEC-API-05 | No input validation at API boundary | All downstream vulns exposed | Medium |
| SEC-INPUT-05 | `customOutputs` NaN propagation | Silent loss of all change funds | Low |
| SEC-PSBT-02 | NaN `changeSatoshis` burns change | Complete fund loss, undetectable | Low |
| SEC-ACTION-04 | No max payload size | Memory exhaustion DoS | Low |

### Priority 2 — HIGH (Address Before Production)

| ID | Finding | Impact | Effort |
|----|---------|--------|--------|
| SEC-INPUT-01 | `data`/`rawData` not validated | Memory exhaustion, invalid txs | Medium |
| SEC-INPUT-02 | `pubkey` not pre-validated | Crash, info leakage | Low |
| SEC-INPUT-03 | `compressedPubKey` no format check | Malformed multisig, fund loss | Low |
| SEC-INPUT-04 | `encoding` enum not validated | Crash on null dereference | Low |
| SEC-INPUT-06 | `fee` accepts any value | Fee manipulation | Low |
| SEC-INPUT-10 | UTXO entries not structurally validated | Malformed PSBTs | Medium |
| SEC-PSBT-03 | p2shHash/p2shHex mismatch | Fund lock in P2SH outputs | Low |
| SEC-FEE-04 | Explicit `fee` bypasses cap | Wallet drain via fees | Low |
| SEC-ERR-01 | Raw exceptions to callers | Info disclosure | Medium |
| SEC-UTXO-01 | Tracker response not validated | Transaction manipulation | Medium |
| SEC-DEP-01 | Deprecated `request` in dependency tree | 2 critical, 2 moderate CVEs | High |
| SEC-ACTION-03 | VERSION field never validated | Silent data corruption | Medium |

### Priority 3 — MEDIUM (Address in Next Release)

| ID | Finding | Impact | Effort |
|----|---------|--------|--------|
| SEC-API-02 | Wildcard CORS | Cross-origin abuse | Low |
| SEC-API-03 | No rate limiting | DoS | Low |
| SEC-CRYPTO-01 | AES key from public TXID | No real confidentiality | N/A (document) |
| SEC-CRYPTO-02 | CTR keystream reuse | Deobfuscation of paired txs | Low |
| SEC-FEE-01 | Floating-point in satoshi math | Fee underestimation | Medium |
| SEC-FEE-02 | `parseInt` without radix | Hex value parsing | Low |
| SEC-NET-01 | Dogecoin missing bech32 | Unrecoverable P2WSH funds | Low |
| SEC-ACTION-02 | Cross-chain ACTIONs not gated | Fee burn, DB pollution | Medium |
| SEC-UTXO-04 | Caller controls AES key | Chosen-key attack | Low |

### Priority 4 — LOW (Track and Address)

| ID | Finding | Impact | Effort |
|----|---------|--------|--------|
| SEC-CRYPTO-03 | `dataToPubkey` invalid EC points | Compatibility rejection | N/A (document) |
| SEC-CRYPTO-04 | `Buffer.allocUnsafe` usage | Theoretical heap leak | Low |
| SEC-ERR-03 | Change amount in error message | Balance disclosure | Low |
| SEC-ERR-04 | Crash on unknown network | Startup DoS | Low |
| SEC-NET-02 | DOGE regtest/testnet identical | Cross-env confusion | Low |
| SEC-NET-03 | P2WSH size hardcoded | Future breakage | Low |
| SEC-UTXO-05 | O(n^2) deduplication | DoS with large UTXO sets | Low |

---

## 6. Mitigation Recommendations

### 6.1 API Hardening (Priority 1)

1. **Add API authentication** — Implement API key or HMAC-based authentication on the JSON-RPC endpoint. At minimum, require a shared secret in request headers.
2. **Restrict CORS** — Replace wildcard CORS with an explicit allowlist of permitted origins.
3. **Add rate limiting** — Use `express-rate-limit` or equivalent to cap requests per IP/key per time window.
4. **Validate all parameters at the API boundary** — Add a validation layer between the JSON-RPC handler and `createTransaction()` that enforces types, ranges, and formats for every parameter before it enters the encoding pipeline.
5. **Set explicit body size limits** — Configure `bodyParser.json({ limit: '50kb' })` and add array length caps for `utxos` and `customOutputs`.

### 6.2 Input Validation (Priority 1-2)

6. **Add NaN guards after all `parseInt` calls** — Every `parseInt` result must be checked with `isNaN()` or `Number.isFinite()` before use in arithmetic. Reject the request if any value is NaN.
7. **Validate `encoding` against an explicit allowlist** — `["opreturn", "p2sh", "p2wsh", "multisign"]` with an error for unrecognized values.
8. **Validate `pubkey` format** before passing to `bitcoin.address.fromBase58Check` — check string length and character set.
9. **Validate `compressedPubKey`** — Must be exactly 66 hex characters, starting with `02` or `03`.
10. **Validate UTXO structure** — Each entry must have `txid` (64 hex chars), `vout` (non-negative integer), `value` (positive integer), `scriptPubKey` (even-length hex string), and `confirmations` (non-negative integer).
11. **Add a maximum data payload size** — Enforce an upper bound (e.g., 100KB) on `data` + `rawData` to prevent memory exhaustion and oversized transactions.
12. **Validate `customOutputs.address`** against the configured network before adding to the PSBT.

### 6.3 Fee & Math Safety (Priority 1-2)

13. **Use integer-only satoshi arithmetic** — Convert all BTC-denominated values to integer satoshis at the API boundary and perform all subsequent math with integers only. Avoid floating-point multiplication chains.
14. **Cap the explicit `fee` parameter** — Apply the same `maxFeePerBytes`-derived upper bound to explicitly provided fees.
15. **Detect negative or NaN `changeSatoshis`** — Before returning the PSBT, assert `changeSatoshis >= 0` and `Number.isFinite(changeSatoshis)`. Throw a clear error if violated.
16. **Always pass radix 10 to `parseInt`** — `parseInt(value, 10)` on all UTXO and custom output value conversions.

### 6.4 PSBT Construction Safety (Priority 2)

17. **Cross-validate `p2shHash` and `p2shHex`** — After `p2shTx = Transaction.fromHex(p2shHex)`, assert `p2shTx.getId() === p2shHash`. Reject with a clear error if mismatched.
18. **Bounds-check `p2shTx.outs` access** — Before accessing `p2shTx["outs"][voutPsbtIndex]`, verify the index is within bounds.
19. **Wrap bitcoinjs-lib calls in try/catch** — Catch library exceptions and re-throw sanitized error messages that do not reveal internal file paths, stack traces, or parameter values.

### 6.5 Error Handling (Priority 2-3)

20. **Implement a global error handler** in Express that catches all unhandled exceptions and returns a generic error message to the caller. Log the full error server-side but never expose it via the API.
21. **Sanitize all error messages** — Remove internal paths, stack traces, and parameter values from API responses. Use error codes (e.g., `INVALID_ADDRESS`, `INSUFFICIENT_FUNDS`) instead of raw library messages.
22. **Remove wallet balance from error messages** — Replace the `changeSatoshis` leak in the fee-burn error with a generic message.

### 6.6 Obfuscation (Priority 3 — Document)

23. **Document the security properties of obfuscation** — Clearly state in the protocol docs and code comments that AES-128-CTR with a public TXID key provides format-obfuscation only, not confidentiality. Any observer with blockchain access can deobfuscate.
24. **Consider per-transaction nonce** if confidentiality is ever a design goal. The current scheme cannot be made secure without changing the key derivation.

### 6.7 Dependency Management (Priority 2)

25. **Replace `bitcoin-core`** — The `request` dependency chain is deprecated and carries 2 critical + 2 moderate CVEs. Replace with a modern JSON-RPC client using `fetch()` or `axios`.
26. **Replace `browserify`** with a modern bundler (`esbuild`, `webpack`, `rollup`) to eliminate the `elliptic` transitive dependency in the browser bundle.
27. **Add `npm audit` to CI** — Run `npm audit --audit-level=high` in CI/CD pipelines to catch new vulnerabilities automatically.

### 6.8 Network Configuration (Priority 3)

28. **Add `bech32` HRP to Dogecoin network configs** or explicitly block P2WSH encoding for Dogecoin networks with a clear error.
29. **Differentiate Dogecoin regtest/testnet address prefixes** to prevent cross-environment confusion.
30. **Gate chain-restricted ACTIONs by network** — If the encoder gains ACTION parsing (recommendation 11), reject BTC-only ACTIONs when `NETWORK` is Dogecoin or Litecoin.

---

*This audit plan identifies 29 findings across 10 security categories. The most critical risks center on the complete absence of input validation at the API boundary, NaN propagation that silently burns change funds, and the lack of API authentication. Addressing Priority 1 items eliminates the highest-impact risks with relatively low implementation effort.*
