# XChain Encoder: Chaos Engineering Plan

## 1. Executive Summary

The `xchain-encoder` constructs PSBTs by encoding ACTION data into blockchain transactions. Failures during encoding can produce invalid transactions, silently burn funds as fees, or crash the API server. This plan defines controlled chaos experiments targeting every failure-prone path in the encoder, its RPC dependencies, and the Express API layer.

The encoder has 45 throw statements, 7 catch blocks, and several unguarded paths where unexpected conditions propagate as unhandled errors. The goal is to verify that every failure mode either produces a clear, safe error or is handled gracefully - and to expose hidden paths where it does not.

---

## 2. Architecture & Failure Surface Map

### 2.1 Component Interaction Diagram

```
Client (HTTP POST)
  │
  ▼
api.js (Express + JSON-RPC)
  ├── Helmet, rate limiter, API key auth
  ├── validator.validateAll()
  │     └── 14 validation functions (TypeError / RangeError)
  └── encoder.createTransaction()
        ├── BlockchainConnector.getFeePerKilobyte()  ← RPC: estimatesmartfee
        ├── UtxoTracker.getUtxosFromAddress()         ← HTTP: get_utxos
        ├── prepareData()                             ← bitcoinjs-lib script ops
        │     └── bitcoin.address.fromBase58Check()
        ├── obfuscate()                               ← crypto.createCipheriv (AES-128-CTR)
        ├── dataToPubkey()                            ← Buffer operations
        ├── Output generation loop
        │     ├── bitcoin.payments.p2sh()
        │     ├── bitcoin.payments.p2wsh()
        │     ├── bitcoin.payments.p2ms()
        │     └── psbt.addOutput()
        ├── Input selection loop
        │     ├── isSegwitUTXO()                      ← bitcoin.script.decompile
        │     ├── BlockchainConnector.getTransactionHex()  ← RPC: getrawtransaction (per legacy input)
        │     └── psbt.addInput()
        ├── Fee arithmetic + change calculation
        └── psbt.toHex()                              ← Serialization
```

### 2.2 Failure Categories

| Category | Components | Blast Radius |
|----------|-----------|-------------|
| **Network I/O** | BlockchainConnector (3 RPC methods), UtxoTracker | Transaction fails, potential timeout hang |
| **Data Integrity** | validator.js, prepareData(), obfuscate() | Invalid PSBT, corrupted ACTION data |
| **Library Internals** | bitcoinjs-lib (Psbt, script, payments), Node.js crypto | Unhandled throws, process crash |
| **Arithmetic** | Fee calculation, change satoshis, UTXO value parsing | Silent fund loss, NaN propagation |
| **Resource** | Memory (large payloads), CPU (crypto ops), event loop | Degraded throughput, OOM |
| **API Layer** | Express middleware, rate limiter, JSON-RPC routing | Denial of service, error leakage |

---

## 3. Chaos Experiments

### Category A: Network & Dependency Failures

---

#### A-1: Coin Daemon Completely Unreachable

**Fault Injection:** Mock `BlockchainConnector` methods to reject with `ECONNREFUSED` after configurable delay (0ms for instant, 30s for timeout simulation).

**Affected Paths:**
- `getFeePerKilobyte()` - line 172 of BlockchainConnector.js
- `getTransactionHex()` - line 131 of BlockchainConnector.js

**Observation:**
- Does the encoder return a structured JSON-RPC error (code -32603)?
- Does the error message leak connection details (host, port, credentials)?
- Does the API process remain alive and serve subsequent requests?
- How long does the request hang before failing (no timeout configured in `cross-fetch`)?

**Expected Safe Outcome:**
- Requests using `feePerKb` parameter bypass fee RPC; only legacy UTXO path should fail.
- Error sanitized to "Internal encoder error" (not "ECONNREFUSED 127.0.0.1:8333").
- Process stays alive; subsequent requests succeed if RPC recovers.

**Risk Identified:** `cross-fetch` has no default timeout. A hanging TCP connection could block the request indefinitely. The encoder has no request-level timeout on RPC calls.

---

#### A-2: Coin Daemon Returns Invalid JSON

**Fault Injection:** Mock `fetch()` to return HTTP 200 with body `"<html>502 Bad Gateway</html>"` (simulating a reverse proxy error).

**Affected Paths:**
- `response.json()` at lines 58/137/178 of BlockchainConnector.js

**Observation:**
- Does `response.json()` throw a SyntaxError?
- Is the SyntaxError caught by the existing try/catch blocks?
- Does the error message leak the HTML body content?

**Expected Safe Outcome:**
- SyntaxError caught in each method's catch block.
- Error wrapped as "Error in network request: ..." or re-thrown cleanly.
- No HTML content leaked to API caller.

---

#### A-3: Coin Daemon Returns RPC Error Object

**Fault Injection:** Mock RPC to return `{ jsonrpc: "2.0", error: { code: -28, message: "Loading block index..." }, id: 1 }` (node still starting up).

**Affected Paths:**
- `getFeePerKilobyte()` - missing `result.feerate`, triggers regtest fallback path
- `getTransactionHex()` - missing `result.hex`, throws "Error getting transaction hex"

**Observation:**
- Does `getFeePerKilobyte()` correctly distinguish between "no feerate" and "RPC error"?
- Does the nested `isRegtest()` call at line 184 also fail if the node is loading?
- If both fail, which error propagates - the original or the nested one?

**Expected Safe Outcome:**
- On mainnet: clear error about fee estimation failure.
- On regtest: falls back to hardcoded 0.00001 fee rate.
- Nested `isRegtest()` failure should not mask the original error.

**Risk Identified:** The nested `isRegtest()` call inside `getFeePerKilobyte()` can throw and replace the original fee estimation error with a different error about blockchain info.

---

#### A-4: UTXO Tracker Unreachable

**Fault Injection:** Mock `UtxoTracker.getUtxosFromAddress()` to throw `Error("ECONNREFUSED")`.

**Affected Paths:**
- `createTransaction()` line 241 - only when `utxos` parameter is null/empty

**Observation:**
- Does the error propagate cleanly to the API?
- Is it sanitized (not leaking tracker URL/port)?
- Does pre-supplying UTXOs via the `utxos` parameter fully bypass this path?

**Expected Safe Outcome:**
- Error caught by api.js encoder catch block, sanitized to "Internal encoder error".
- Supplying UTXOs directly completely avoids the tracker dependency.

---

#### A-5: UTXO Tracker Returns Malformed Response

**Fault Injection:** Mock tracker to return responses with progressively worse corruption:
1. `{ result: null }`
2. `{ result: { utxos: "not-an-array" } }`
3. `{ result: { utxos: [{ txid: 123 }] } }` (txid is number, not string)
4. `{ result: { utxos: [{ txid: "aa...", vout: 0 }] } }` (missing `value`)

**Observation:**
- Does each malformation trigger the correct TypeError from UtxoTracker validation?
- Are error messages specific enough to diagnose the issue?
- Does any malformation slip past validation and cause a downstream crash?

**Expected Safe Outcome:**
- Cases 1: "Error getting utxos: empty result"
- Cases 2: "UTXO tracker result missing utxos array"
- Cases 3-4: "UTXO tracker returned malformed utxo at index 0"

---

#### A-6: Intermittent RPC Failures (Flaky Network)

**Fault Injection:** Mock `BlockchainConnector` methods to fail on alternating calls (50% failure rate). Run 100 sequential encoding requests.

**Observation:**
- Does the encoder correctly fail individual requests without corrupting shared state?
- Does the Express server stay responsive between failures?
- Are there any resource leaks (unclosed connections, growing memory)?
- Do successful requests return valid PSBTs despite interleaved failures?

**Expected Safe Outcome:**
- Each request is independent; failures don't poison subsequent requests.
- Memory stable across the 100-request run.
- Error rate matches injection rate (50%).

---

#### A-7: Slow RPC Responses (Latency Injection)

**Fault Injection:** Mock `getTransactionHex()` to resolve after configurable delays: 1s, 5s, 30s, 120s.

**Affected Path:** Input selection loop (line 514) - called N times for N legacy UTXOs.

**Observation:**
- With 10 legacy UTXOs and 5s delay each, total request takes ~50s. Does the API client timeout?
- Does Express kill the request? Is there a server-side timeout?
- Does the encoder hold resources (memory, PSBT state) during the entire wait?

**Expected Safe Outcome:**
- Request should eventually complete or timeout with a clear error.

**Risk Identified:** No server-side request timeout configured. A request with many legacy UTXOs and a slow node could hang for minutes, blocking the Express worker.

---

### Category B: Input & Data Corruption

---

#### B-1: Empty UTXO Array After Deduplication

**Fault Injection:** Supply UTXOs that are ALL duplicates or ALL unconfirmed with `unconfirmed=false`:
1. `[makeSegwitUtxo(TXID_A, 0, 100000), makeSegwitUtxo(TXID_A, 0, 100000)]` with `unconfirmed=false` and `confirmations=0`
2. `[makeMempoolUtxo(TXID_A, 0, 100000)]` with `unconfirmed=false`

**Affected Path:** After dedup loop (line 273), array is empty. Line 276 sorts empty array (no-op). Line 277: `utxos[0]["txid"]` throws TypeError on undefined.

**Observation:**
- Does the encoder crash with an unhandled TypeError?
- Is the error message meaningful ("Cannot read properties of undefined")?
- Does the API process survive?

**Expected Safe Outcome:** The encoder should detect an empty array after dedup/filtering and throw a clear error like "no usable UTXOs remain after filtering". Currently this is an **unguarded crash path**.

**Risk Level: HIGH** - This is a discoverable crash bug. Any user supplying only mempool UTXOs with `unconfirmed=false` triggers it.

---

#### B-2: UTXO Values at Arithmetic Boundaries

**Fault Injection:** Supply UTXOs with extreme values:
1. `value: 0` (zero-value UTXO)
2. `value: 1` (1 satoshi - below any dust threshold)
3. `value: 2100000000000000` (21M BTC in satoshis - max supply)
4. `value: Number.MAX_SAFE_INTEGER` (9007199254740991)
5. `value: "0xff"` (hex string - parseInt with radix 10 returns 0)

**Affected Paths:**
- UTXO value parsing at line 490: `parseInt(nextUtxo.value, 10)`
- Fee arithmetic at line 528: `estimatedTxSize * feePerBytes * SATOSHI_UNIT`
- Change calculation at line 544: `inputSatoshis - outputSatoshis - estimatedFee`

**Observation:**
- Does `parseInt("0xff", 10)` return `0` (not 255)? If so, the UTXO contributes 0 satoshis but is consumed as an input.
- With `MAX_SAFE_INTEGER`, does `inputSatoshis + nextUtxo.value` lose precision?
- Does `value: 0` pass the NaN/negative check but create a useless input?

**Expected Safe Outcome:**
- `"0xff"` → `parseInt` returns `0`, passes the `isNaN` check, but silently contributes nothing. Should ideally be caught.
- `MAX_SAFE_INTEGER` → JavaScript loses integer precision above 2^53; arithmetic may produce incorrect change amounts.
- `value: 0` → passes validation, input consumed but adds 0 satoshis.

**Risk Level: MEDIUM** - Hex string values and precision overflow are subtle fund-loss vectors.

---

#### B-3: Obfuscation Key Edge Cases

**Fault Injection:** Supply UTXOs with TXIDs that produce degenerate AES keys:
1. `txid: "0".repeat(64)` - key = "0000000000000000", IV = "0000000000000000"
2. `txid: "f".repeat(64)` - key = "ffffffffffffffff"
3. `txid: "a".repeat(31) + "0"` - key shorter than 16 chars after substr (31 hex chars → 15.5 bytes)
4. `txid: ""` - empty string

**Affected Path:** `obfuscate()` at line 174-182. `key.substr(0,16)` and `key.substr(16,16)`.

**Observation:**
- Does `crypto.createCipheriv` accept a key/IV shorter than 16 bytes?
- With all-zero key+IV, is AES-128-CTR still a valid cipher? (Yes, but trivially breakable)
- With empty txid, does `"".substr(0,16)` return `""` → cipher creation fails?
- Does any degenerate key produce identical ciphertext to plaintext (CTR mode with zero key)?

**Expected Safe Outcome:**
- Empty/short txid should fail at cipher creation with a clear error.
- All-zero/all-F keys should produce valid (if weak) ciphertext - this is a security concern, not a crash.

**Risk Level: LOW** (crash) / **MEDIUM** (security) - Degenerate keys are unlikely in production since TXIDs come from real transactions, but a crafted UTXO list could exploit this.

---

#### B-4: Maximum Payload Stress

**Fault Injection:** Supply data at exact boundaries:
1. `data` of exactly 65,536 bytes (maximum allowed)
2. `data` of 65,533 bytes + `rawData` of 3 bytes (combined = 65,536 after script.compile overhead)
3. `data` of 65,537 bytes (one byte over limit)
4. `data` that compiles to exactly 65,536 bytes after `bitcoin.script.compile()`

**Affected Path:** `script.compile()` at line 224, size check at line 226.

**Observation:**
- `bitcoin.script.compile([buffer])` adds length-prefix opcodes. A 65,536-byte buffer may compile to >65,536 bytes. Does the size check catch this?
- What happens with 65,536-byte P2WSH encoding? How many chunks (65536 / 3571 = ~18 chunks)?
- Does the PSBT with 18+ outputs serialize correctly?
- Memory usage during 18-chunk P2WSH construction?

**Expected Safe Outcome:**
- Payloads <=65,536 compiled bytes accepted; >65,536 rejected with RangeError.
- Large P2WSH transactions succeed but may be slow.

---

#### B-5: Corrupted scriptPubKey in UTXOs

**Fault Injection:** Supply UTXOs with malformed scriptPubKey values:
1. `scriptPubKey: ""` (empty)
2. `scriptPubKey: "zzzz"` (non-hex)
3. `scriptPubKey: "00"` (too short for any script type)
4. `scriptPubKey: "0014" + "ff".repeat(20)` (valid P2WPKH format but garbage hash)
5. `scriptPubKey: null`

**Affected Paths:**
- `isSegwitUTXO()` line 61: `bitcoin.script.decompile(Buffer.from(utxo.scriptPubKey, 'hex'))`
- Input addition at lines 505/519: `Buffer.from(nextUtxo.scriptPubKey, 'hex')`

**Observation:**
- Does `isSegwitUTXO()` catch the error and return false (safe fallback)?
- If classified as non-segwit, does `getTransactionHex()` succeed for a real UTXO?
- Case 5 (null): Does `Buffer.from(null, 'hex')` throw?

**Expected Safe Outcome:**
- `isSegwitUTXO()` has a try/catch returning false - cases 1-3 should be safe.
- Case 4: Classified as segwit, added to PSBT with garbage script. PSBT is technically valid but unsignable.
- Case 5: `Buffer.from(null, 'hex')` throws TypeError - propagates unhandled.

**Risk Level: HIGH** - A null scriptPubKey bypasses `isSegwitUTXO()` silently (try/catch returns false) then crashes at line 519 inside `Buffer.from(null, 'hex')` in the legacy UTXO path.

---

#### B-6: ACTION Payload with Binary/NUL Content

**Fault Injection:** Supply `data` parameter containing:
1. NUL bytes: `"SEND|0|JDOG|1|addr\x00INJECTED"`
2. Control characters: `"SEND|0|\x01\x02\x03|1|addr"`
3. Multi-byte UTF-8 overlong encoding
4. Extremely long single pipe-delimited field (500KB within 65KB limit via gzip confusion)

**Affected Path:** `Buffer.from(data, 'utf8')` at line 216, then `bitcoin.script.compile()` at line 224.

**Observation:**
- Does NUL in data corrupt the pipe-delimited parsing downstream (decoder side)?
- Does `Buffer.from()` handle all UTF-8 edge cases?
- Does `script.compile()` accept arbitrary binary content?

**Expected Safe Outcome:**
- The encoder embeds raw bytes - it does not parse ACTION semantics. Binary content should encode and obfuscate correctly.
- The downstream decoder would need to handle NUL bytes during deobfuscation/parsing.

---

### Category C: Library & Crypto Failures

---

#### C-1: bitcoinjs-lib Psbt.addInput() Rejection

**Fault Injection:** Mock `bitcoin.Psbt` to throw on the Nth `addInput()` call:
1. First call fails (no inputs added)
2. Third call fails (partial PSBT with 2 inputs)
3. Throw specific errors: `"Data for input key 0 is not a buffer"`, `"Duplicate input"`

**Affected Path:** Lines 509/521 - inside the input selection while-loop.

**Observation:**
- If addInput fails mid-loop, does the partially-constructed PSBT leak?
- Does the error propagate cleanly or is it a generic "Internal encoder error"?
- Is there any cleanup/rollback of the PSBT state?

**Expected Safe Outcome:**
- Error propagates to API, PSBT is garbage-collected (no persistent state).
- Error should be caught by api.js encoder catch block.

**Risk Level: LOW** - bitcoinjs-lib is well-tested, but version upgrades could change error behavior.

---

#### C-2: bitcoinjs-lib Psbt.addOutput() Rejection

**Fault Injection:** Mock `psbt.addOutput()` to throw on:
1. OP_RETURN output (data output)
2. P2SH address output
3. Change address output (last output added)

**Affected Path:** Lines 299/360/410/440/469/555 - multiple addOutput calls throughout createTransaction.

**Observation:**
- A throw during OP_RETURN output addition fails the entire transaction.
- A throw during change output addition means data outputs are already added but the PSBT is incomplete.
- Does the PSBT get returned in a partial state, or does the error prevent return?

**Expected Safe Outcome:**
- Error propagates, PSBT never returned. Since the return is at line 561 (after all addOutput calls), any throw prevents the return.

---

#### C-3: crypto.createCipheriv() Failure

**Fault Injection:** Monkey-patch `crypto.createCipheriv` to:
1. Throw `Error("FIPS mode enabled - AES-128-CTR not allowed")`
2. Return a cipher that throws on `.update()`
3. Return a cipher whose `.final()` returns corrupted data

**Affected Path:** `obfuscate()` at line 178.

**Observation:**
- Does the error propagate cleanly?
- If `.final()` returns corrupted data, is the PSBT produced with bad obfuscation? (The encoder has no integrity check on obfuscation output.)
- Would a FIPS-mode Node.js environment break the encoder entirely?

**Expected Safe Outcome:**
- Cases 1-2: Error propagates, no PSBT returned.
- Case 3: PSBT produced with corrupted data - **silent data corruption**. The decoder would fail to deobfuscate, but the transaction would still be broadcast.

**Risk Level: HIGH** - Silent data corruption in the crypto path produces transactions that are valid on-chain but decode to garbage. No integrity check exists.

---

#### C-4: bitcoin.script.compile() Edge Cases

**Fault Injection:** Supply data that causes `script.compile()` to produce unexpected results:
1. Empty data + empty rawData → `script.compile([Buffer.alloc(0)])`
2. Data that looks like an opcode (e.g., single byte `0x00` → OP_0)
3. Very large single buffer (65,535 bytes)

**Affected Path:** Line 224: `bitcoin.script.compile(dataToCompile)`

**Observation:**
- Does compiling an empty buffer produce a valid script?
- Does a single-byte buffer get interpreted as an opcode instead of data?
- What pushdata encoding does bitcoinjs-lib use for >65,535 bytes?

**Expected Safe Outcome:**
- `script.compile` should produce valid pushdata scripts for all buffer sizes up to 65,536 bytes.
- The size check at line 226 catches compiled output >65,536 bytes.

---

#### C-5: bitcoin.address.fromBase58Check() with Non-Base58 Input

**Fault Injection:** Supply pubkey values that are:
1. A bech32 address (`bc1q...`)
2. A hex string (not base58)
3. A valid base58 string for the wrong network
4. An empty string

**Affected Path:** `prepareData()` line 124 - called for P2SH/P2WSH encoding.

**Observation:**
- Does bech32 input throw from `fromBase58Check()`?
- Is the error message clear about what's wrong?
- Does wrong-network base58 produce a PSBT with cross-network outputs?

**Expected Safe Outcome:**
- Cases 1-2-4: TypeError from bs58check, propagates cleanly.
- Case 3: Base58Check decodes successfully but produces a hash for the wrong network. The PSBT is valid but targets the wrong chain - **silent cross-network error**.

**Risk Level: MEDIUM** - Cross-network pubkey would produce a transaction that's spendable on the wrong chain.

---

### Category D: Arithmetic & State Corruption

---

#### D-1: Fee Calculation Overflow

**Fault Injection:** Create conditions where fee arithmetic overflows:
1. `feePerKb: 999999999` (absurdly high fee) + large tx size
2. 500 UTXOs each adding to `estimatedTxSize` → very large size estimate
3. `feePerBytes * SATOSHI_UNIT` exceeds `Number.MAX_SAFE_INTEGER`

**Affected Path:** Line 528: `Math.trunc(estimatedTxSize * feePerBytes * SATOSHI_UNIT)`

**Observation:**
- Does the `maxFeePerBytes` cap (line 207-209) prevent this if configured?
- Without the cap, does `changeSatoshis` go negative?
- Does the `Number.isFinite()` guard at line 546 catch Infinity?
- What happens with very negative `changeSatoshis`? Is change output omitted (line 554)?

**Expected Safe Outcome:**
- `Number.isFinite()` catches `NaN` and `Infinity`.
- Negative `changeSatoshis` that is still finite: change output omitted silently. The excess goes to the miner as fee - **silent fund loss**.

**Risk Level: HIGH** - Negative but finite `changeSatoshis` is not checked. If fee > inputs, the transaction burns all input value as miner fee with no error.

---

#### D-2: Insufficient UTXOs for Outputs + Fee

**Fault Injection:** Supply UTXOs whose total value is less than outputs + minimum fee:
1. Single UTXO of 1000 satoshis, data requiring 3 P2SH outputs at 546 satoshis each
2. Total input = 1000, total output = 1638, fee = 546 minimum → needs 2184

**Affected Path:** Input selection loop exits at line 533 (`break` when input > output + fee). If loop exhausts all UTXOs without breaking, execution continues.

**Observation:**
- Does the loop terminate correctly when UTXOs are exhausted?
- What's the value of `changeSatoshis` when inputs < outputs + fee?
- Is a negative change value caught?

**Expected Safe Outcome:**
- `changeSatoshis` becomes negative. `Number.isFinite(-value)` returns true.
- `changeSatoshis > 0` is false → no change output added.
- `changeSatoshis > this.dustAmount` may be false → no "provide change address" error.
- The PSBT is returned with negative implicit fee (outputs > inputs). **This PSBT is invalid and will be rejected by the network**, but the encoder returns it without error.

**Risk Level: MEDIUM** - The encoder does not validate that inputs >= outputs + fee. It relies on the network to reject the transaction, but the caller may not expect a "successful" encoding to produce an invalid PSBT.

---

#### D-3: Concurrent State Mutation

**Fault Injection:** Call `createTransaction()` twice concurrently on the same encoder instance with different parameters.

**Observation:**
- Does the encoder maintain any instance-level mutable state between calls?
- `this.connector`, `this.utxoTrackerConnector`, `this.network`, `this.dustAmount` - all set in constructor.
- `createTransaction()` uses local variables - should be safe.
- But: do the mock objects' shared state cause issues?

**Expected Safe Outcome:**
- The encoder is stateless per-call (all variables are function-local). Concurrent calls should be safe.
- Confirm: no writes to `this.*` inside `createTransaction()`.

---

#### D-4: UTXO Reuse Across Transactions

**Fault Injection:** Call `createTransaction()` twice with the same UTXO list. Both PSBTs spend the same inputs.

**Observation:**
- The encoder doesn't track spent UTXOs - it's the caller's responsibility.
- Does the encoder produce two valid PSBTs spending the same inputs?
- If both are signed and broadcast, the second is a double-spend (one will be rejected).

**Expected Safe Outcome:**
- Both PSBTs are valid individually. The encoder correctly does not enforce UTXO exclusivity (that's the caller's domain). But this should be documented.

---

### Category E: Resource Exhaustion

---

#### E-1: Memory Pressure During Large P2WSH Encoding

**Fault Injection:** Encode a 65,536-byte payload with P2WSH encoding (produces ~18 chunks, each requiring script compilation, obfuscation, and PSBT output addition).

**Observation:**
- Peak memory usage during encoding?
- How many Buffer allocations occur?
- Does garbage collection cause latency spikes?

**Expected Safe Outcome:**
- Memory usage should not exceed ~200MB for a single maximum-size transaction.
- No OOM for a single request on a server with 512MB+ RAM.

---

#### E-2: 500 UTXOs with Legacy Scripts

**Fault Injection:** Supply 500 legacy (P2PKH) UTXOs. Each triggers a `getTransactionHex()` RPC call.

**Observation:**
- 500 sequential HTTP requests to the coin daemon.
- Total encoding time with even 10ms RPC latency = 5 seconds minimum.
- Memory: 500 raw transaction buffers held simultaneously.
- PSBT with 500 inputs - serialization time?

**Expected Safe Outcome:**
- The request completes but is very slow.
- Memory remains bounded (each raw tx buffer is freed after PSBT input addition... or is it? Verify GC behavior).

---

#### E-3: Rapid Request Flooding Past Rate Limiter

**Fault Injection:** Send 1000 requests in 1 second to the API.

**Observation:**
- Does the rate limiter (default 60/min) correctly reject excess requests with 429?
- Is the rate limiter response a valid JSON-RPC error?
- Does the Express process stay responsive to legitimate requests after the flood?
- Memory impact of queued/rejected requests?

**Expected Safe Outcome:**
- First 60 requests accepted; remaining 940 rejected with code -32029.
- Process remains stable.

---

#### E-4: Event Loop Blocking Under Concurrent Load

**Fault Injection:** Send 50 concurrent requests, each encoding a moderate P2SH payload.

**Observation:**
- Event loop delay during processing?
- Do any requests timeout?
- Does response latency degrade linearly with concurrency?

**Expected Safe Outcome:**
- Response latency increases under concurrency (single-threaded Node.js).
- No requests crash; all get valid responses or timeout errors.

---

### Category F: API Layer Failures

---

#### F-1: Malformed JSON-RPC Request

**Fault Injection:** Send requests with:
1. Invalid JSON body: `"not json at all"`
2. Missing `method` field: `{ jsonrpc: "2.0", id: 1 }`
3. Wrong method name: `{ method: "nonexistent" }`
4. Params as string instead of object: `{ method: "create_tx", params: "bad" }`
5. Extremely large body (2MB, exceeding 1MB limit)

**Observation:**
- Does each case return a proper JSON-RPC error?
- Does case 5 get rejected by the body parser before reaching the encoder?
- Are error responses valid JSON?

**Expected Safe Outcome:**
- Case 1: 400 Bad Request from body-parser.
- Case 2-3: JSON-RPC "method not found" error.
- Case 4: Validator catches non-object params.
- Case 5: 413 Payload Too Large from Express.

---

#### F-2: API Key Bypass Attempts

**Fault Injection:** When `API_KEY` is configured, send requests with:
1. No `x-api-key` header
2. Empty `x-api-key` header
3. Wrong `x-api-key` value
4. `x-api-key` in query string instead of header
5. Multiple `x-api-key` headers with different values

**Observation:**
- Are all cases correctly rejected with 401?
- Does the rate limiter count rejected requests?
- Is timing consistent (no timing side-channel on key comparison)?

**Expected Safe Outcome:**
- All cases return 401 with JSON-RPC error code -32001.

**Risk Identified:** The API key comparison uses `===` (strict equality), which in JavaScript is constant-time for string comparison in V8. However, the early-return pattern means rejected requests are faster than accepted ones - this could be used to confirm that an API key is required.

---

#### F-3: psbt.toHex() Failure at API Response

**Fault Injection:** Monkey-patch `Psbt.prototype.toHex` to throw after `createTransaction()` succeeds.

**Affected Path:** api.js line 124: `psbt["psbt"] = psbt["psbt"].toHex()`.

**Observation:**
- This line is OUTSIDE the try/catch block for encoder errors (lines 106-122).
- Does the throw become an unhandled error?
- Does Express catch it or does the process crash?
- Does the JSON-RPC router have its own error handling?

**Expected Safe Outcome:**
- `express-json-rpc-router` should catch the error and return a -32603 error.
- If it doesn't, Express's default error handler returns 500.

**Risk Level: MEDIUM** - If `express-json-rpc-router` doesn't catch this, the response may not be valid JSON-RPC.

---

## 4. Tools & Approach

### 4.1 Fault Injection Methods

| Method | Use Case | Implementation |
|--------|----------|---------------|
| **Direct mock replacement** | Network dependencies (BlockchainConnector, UtxoTracker) | Replace `encoder.connector` and `encoder.utxoTrackerConnector` with objects that throw/delay/return bad data. Follows existing test patterns from `utxoFactory.js`. |
| **Monkey-patching** | Library internals (bitcoinjs-lib, Node.js crypto) | Override `Psbt.prototype.addInput`, `crypto.createCipheriv`, etc. Restore after each experiment. |
| **Controlled test data** | Input corruption experiments | Use `utxoFactory` and `actionFactory` helpers with crafted edge-case values. |
| **Resource constraints** | Memory/CPU pressure | Use `--max-old-space-size=64` flag to limit heap. Use `worker_threads` to saturate CPU during encoding. |
| **HTTP-level injection** | API layer experiments | Use raw HTTP requests (curl/k6) with malformed bodies, headers, and flooding patterns. |

### 4.2 Monitoring During Experiments

| Metric | Tool | Purpose |
|--------|------|---------|
| Process alive/crashed | `process.exitCode`, `child_process` monitoring | Detect unhandled crashes |
| Error type and message | Capture thrown errors, API response bodies | Verify error sanitization |
| PSBT validity | `bitcoin.Psbt.fromHex()` on output | Detect corrupted/partial PSBTs |
| Memory usage | `process.memoryUsage()` before/after | Detect leaks |
| Event loop delay | `perf_hooks.monitorEventLoopDelay()` | Detect blocking |
| Response latency | `process.hrtime.bigint()` / k6 metrics | Detect degradation |
| Console output | Capture `console.error` calls | Verify logging happens on failures |

### 4.3 Experiment Execution Framework

Each experiment follows the **Steady State → Inject → Observe → Verify → Restore** cycle:

1. **Steady State:** Run a baseline encoding (BASE-01 from bench.js) to confirm normal operation.
2. **Inject:** Apply the fault (mock replacement, monkey-patch, bad data).
3. **Observe:** Run the encoding and capture: error/success, error type/message, process state, PSBT validity.
4. **Verify:** Compare against expected outcome. Flag any deviation as a finding.
5. **Restore:** Remove the fault. Run baseline again to confirm no persistent state corruption.

---

## 5. Prioritized Roadmap

### Phase 1: Critical Safety (Week 1)

**Priority: CRITICAL** - These experiments target paths that could cause fund loss or process crashes.

| ID | Experiment | Risk | Rationale |
|----|-----------|------|-----------|
| B-1 | Empty UTXO array after dedup | HIGH | Known unguarded crash path |
| D-1 | Fee calculation overflow | HIGH | Negative change = silent fund loss |
| D-2 | Insufficient UTXOs | MEDIUM | Invalid PSBT returned as "success" |
| C-3 | Crypto corruption | HIGH | Silent data corruption |
| B-5 | Null scriptPubKey | HIGH | Unguarded crash in legacy path |

**Deliverable:** Bug reports for each finding; defensive patches proposed.

### Phase 2: Dependency Resilience (Week 2)

**Priority: HIGH** - Network failures are the most likely production issue.

| ID | Experiment | Risk | Rationale |
|----|-----------|------|-----------|
| A-1 | Coin daemon unreachable | HIGH | Most common operational failure |
| A-7 | Slow RPC responses | MEDIUM | No request timeout configured |
| A-3 | RPC error object | MEDIUM | Nested isRegtest() error masking |
| A-4 | UTXO tracker unreachable | MEDIUM | Dependency isolation verification |
| A-5 | Malformed tracker response | MEDIUM | Input validation coverage |
| A-6 | Intermittent failures | LOW | State isolation verification |

**Deliverable:** Resilience assessment; timeout recommendations.

### Phase 3: Input Corruption (Week 3)

**Priority: MEDIUM** - Adversarial input testing.

| ID | Experiment | Risk | Rationale |
|----|-----------|------|-----------|
| B-2 | UTXO value boundaries | MEDIUM | Hex string / precision overflow |
| B-3 | Obfuscation key edge cases | MEDIUM | Degenerate AES keys |
| B-4 | Maximum payload stress | LOW | Boundary behavior |
| B-6 | Binary/NUL content | LOW | Encoding fidelity |
| C-5 | Cross-network pubkey | MEDIUM | Silent wrong-chain output |

**Deliverable:** Validation gap report; encoder hardening recommendations.

### Phase 4: API & Resource (Week 4)

**Priority: MEDIUM** - Operational resilience.

| ID | Experiment | Risk | Rationale |
|----|-----------|------|-----------|
| F-1 | Malformed JSON-RPC | LOW | API robustness |
| F-2 | API key bypass | LOW | Security posture |
| F-3 | psbt.toHex() failure | MEDIUM | Unguarded API path |
| E-1 | Memory pressure | LOW | Large payload handling |
| E-2 | 500 legacy UTXOs | LOW | Performance degradation |
| E-3 | Rate limiter flooding | LOW | DoS protection |
| E-4 | Event loop blocking | LOW | Concurrency behavior |

**Deliverable:** API hardening report; resource limit recommendations.

---

## 6. Integration Strategy

### 6.1 Development Workflow

- **Pre-merge:** Run Phase 1 experiments (critical safety) as part of the test suite for any PR touching `createTransaction()`, `prepareData()`, `obfuscate()`, or fee calculation logic.  
- **Post-refactor:** Run full chaos suite after any significant refactor of the encoding pipeline.  
- **Dependency upgrade:** Run Category C experiments (library failures) after any `bitcoinjs-lib` or Node.js crypto update.

### 6.2 CI Integration

| Trigger | Experiments | Duration |
|---------|------------|----------|
| Every PR to `src/` | B-1, D-1, D-2, B-5 (critical crash/fund-loss paths) | <30 seconds |
| Nightly | All Phase 1 + Phase 2 experiments | <5 minutes |
| Weekly | Full chaos suite (all phases) | <15 minutes |

The chaos experiments should run as standalone Mocha tests under `test/chaos/` with `--timeout 30000`. Each test:
1. Creates a mocked encoder
2. Injects the specific fault
3. Calls `createTransaction()` or the API
4. Asserts the expected outcome (error type, message, process state)

### 6.3 Staging Environment

For experiments requiring a real coin daemon (A-1, A-7, E-2):
- Run against a regtest node with `xchain-regtest-miner`
- Use iptables/tc to simulate network conditions (latency, packet loss, connection reset)
- Monitor with the performance suite's MemoryTracker and EldTracker

---

## 7. Reporting

### 7.1 Experiment Result Format

Each experiment produces a finding:

```markdown
### [ID] Experiment Name

**Status:** PASS | FAIL | UNEXPECTED  
**Fault Injected:** [description]  
**Observed Behavior:** [what actually happened]  
**Expected Behavior:** [what should have happened]  
**Impact:** [crash / fund loss / data corruption / degraded performance / none]  
**Severity:** CRITICAL | HIGH | MEDIUM | LOW  
**Recommendation:** [defensive fix or monitoring improvement]
```

### 7.2 Known Risk Summary (Pre-Experiment)

Based on the code analysis, these are **predicted findings** before running experiments:

| ID | Predicted Finding | Severity |
|----|------------------|----------|
| B-1 | Empty UTXO array after dedup causes unhandled TypeError crash | CRITICAL |
| D-1 | Negative finite `changeSatoshis` silently burns funds as fee | CRITICAL |
| D-2 | Insufficient UTXOs produce invalid PSBT returned as "success" | HIGH |
| C-3 | Corrupted cipher output produces valid-looking but garbage PSBT | HIGH |
| A-7 | No request timeout on RPC calls allows indefinite request hang | HIGH |
| B-5 | Null scriptPubKey crashes in legacy UTXO path | HIGH |
| A-3 | Nested `isRegtest()` masks original fee estimation error | MEDIUM |
| B-2 | Hex string UTXO values parsed as 0 by parseInt radix 10 | MEDIUM |
| F-3 | `psbt.toHex()` failure outside try/catch block | MEDIUM |
| C-5 | Cross-network pubkey produces valid but wrong-chain P2SH output | MEDIUM |

### 7.3 Tracking

- Results tracked in `reports/XCHAIN_ENCODER_CHAOS_RESULTS.md` (updated after each experiment run).
- Critical and high-severity findings create issues for immediate remediation.
- Resolved findings remain documented with the fix commit hash.
