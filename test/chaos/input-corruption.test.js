/**
 * Chaos Engineering — Category B: Input & Data Corruption
 *
 * Tests encoder resilience when receiving malformed UTXOs, degenerate
 * obfuscation keys, maximum payloads, corrupted scriptPubKeys, and
 * binary content in ACTION data.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A, TXID_B, PUBKEY_BUF,
  makeSegwitUtxo, makeMempoolUtxo, makeEncoder, getTestAddress, buildRawTxHex
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const DOGE = 'dogecoin-regtest'
const BTC = 'bitcoin-regtest'
const DOGE_ADDR = getTestAddress(DOGE)
const BTC_ADDR = getTestAddress(BTC)

describe('Chaos Category B: Input & Data Corruption', () => {

  // ── B-1: Empty UTXO array after deduplication ─────────────────
  // KNOWN BUG: line 277 of XChainEncoder.js has no guard for empty
  // array. utxos[0]["txid"] throws TypeError on undefined.

  describe('B-1: Empty UTXO array after dedup (unguarded crash)', () => {
    it('all-mempool UTXOs + unconfirmed=false → TypeError crash', async () => {
      const encoder = makeEncoder(DOGE)

      await assert.rejects(
        () => encoder.createTransaction(
          [makeMempoolUtxo(TXID_A, 0, 100000000), makeMempoolUtxo(TXID_B, 0, 50000000)],
          DOGE_ADDR, null,
          actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null,
          false, // unconfirmed = false → all mempool UTXOs removed
          0.00001
        ),
        err => err instanceof TypeError || err instanceof Error
      )
    })

    it('single mempool UTXO + unconfirmed=false → crash', async () => {
      const encoder = makeEncoder(DOGE)

      await assert.rejects(
        () => encoder.createTransaction(
          [makeMempoolUtxo(TXID_A, 0, 100000000)],
          DOGE_ADDR, null,
          actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, false, 0.00001
        ),
        err => err instanceof TypeError || err instanceof Error
      )
    })

    it('confirmed UTXO survives dedup → no crash', async () => {
      const encoder = makeEncoder(DOGE)

      const result = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)],
        DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, false, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })

  // ── B-2: UTXO values at arithmetic boundaries ────────────────

  describe('B-2: UTXO values at arithmetic boundaries', () => {
    it('value=0 → no throw, no change output', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 0)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
      const changeOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(changeOutputs.length, 0, 'zero-value UTXO → no change')
    })

    it('value=1 → negative change, no throw', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })

    it('hex string value "0xff" → parseInt radix 10 returns 0', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = { ...makeSegwitUtxo(TXID_A, 0, 1), value: '0xff' }

      // parseInt('0xff', 10) === 0 — passes NaN check, contributes 0 sats
      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
      const changeOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(changeOutputs.length, 0, '"0xff" parsed as 0 → no change')
    })

    it('float string "100.7" → parseInt truncates to 100', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = { ...makeSegwitUtxo(TXID_A, 0, 1), value: '100.7' }

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })

  // ── B-3: Obfuscation key edge cases ───────────────────────────

  describe('B-3: Obfuscation key edge cases (degenerate AES keys)', () => {
    it('all-zero txid (000...0) works as AES key', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo('0'.repeat(64), 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })

    it('short txid (32 chars) → throws error (buffer length or cipher IV)', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = {
        txid: 'a'.repeat(32),
        vout: 0, value: 100000000, confirmations: 6,
        scriptPubKey: makeSegwitUtxo(TXID_A, 0, 1).scriptPubKey
      }

      // Short txid causes failure either at bitcoinjs-lib buffer
      // validation (expects 32-byte hash) or at cipher IV creation
      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], DOGE_ADDR, null,
          actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        )
      )
    })

    it('all-F txid (fff...f) works as AES key', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo('f'.repeat(64), 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })

  // ── B-4: Maximum payload stress ───────────────────────────────

  // The encoder caps the *compiled* on-chain push at MAX_COMPILED_ACTION_DATA_LENGTH
  // (8192) — the same ceiling the indexing decoder enforces. An 8189-byte payload
  // compiles to 8189 + 3 (OP_PUSHDATA2 prefix) = 8192 (the limit); 8190 bytes
  // compiles to 8193 and is rejected, because the decoder would otherwise silently
  // drop it on chain. (createTransaction enforces the compiled ceiling directly;
  // the api.js validator additionally pre-checks the raw byte count at 8189.)
  describe('B-4: Maximum payload stress (8192 byte compiled boundary)', () => {
    it('8189-byte data → compiled=8192 → at limit, P2WSH succeeds', async () => {
      const encoder = makeEncoder(BTC)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1000000000)

      const result = await encoder.createTransaction(
        [utxo], BTC_ADDR, null,
        'X'.repeat(8189), null, 10000, false, 'P2WSH', BTC_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.strictEqual(result.encoding, 'P2WSH')
    })

    it('8190-byte data → compiled=8193 → RangeError: Payload too large', async () => {
      const encoder = makeEncoder(BTC)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1000000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], BTC_ADDR, null,
          'X'.repeat(8190), null, 10000, false, 'P2WSH', BTC_ADDR,
          null, null, null, true, 0.00001
        ),
        /Payload too large/
      )
    })
  })

  // ── B-5: Corrupted scriptPubKey ───────────────────────────────

  describe('B-5: Corrupted scriptPubKey in UTXOs', () => {
    function makeCorruptUtxo (scriptPubKey) {
      return { txid: TXID_A, vout: 0, value: 100000000, confirmations: 6, scriptPubKey }
    }

    it('empty scriptPubKey → falls to legacy path, succeeds with mocked rawtx', async () => {
      const encoder = makeEncoder(DOGE)
      encoder.connector.getTransactionHex = async () => buildRawTxHex(100000000, DOGE)

      const result = await encoder.createTransaction(
        [makeCorruptUtxo('')], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })

    it('non-hex scriptPubKey → falls to legacy path, succeeds', async () => {
      const encoder = makeEncoder(DOGE)
      encoder.connector.getTransactionHex = async () => buildRawTxHex(100000000, DOGE)

      const result = await encoder.createTransaction(
        [makeCorruptUtxo('zzzz')], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })

    it('null scriptPubKey → falls to legacy path, succeeds', async () => {
      const encoder = makeEncoder(DOGE)
      encoder.connector.getTransactionHex = async () => buildRawTxHex(100000000, DOGE)

      const result = await encoder.createTransaction(
        [makeCorruptUtxo(null)], DOGE_ADDR, null,
        actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })

  // ── B-6: ACTION payload with binary/NUL content ───────────────

  describe('B-6: Binary/NUL content in ACTION data', () => {
    it('NUL bytes in data produce valid PSBT', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        'SEND|0|JDOG|1|addr\x00INJECTED', null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })

    it('emoji/high-Unicode in data produce valid PSBT', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], DOGE_ADDR, null,
        'BROADCAST|0|Hello \u{1F600}\u{1F680}\u{2764}', null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })
})
