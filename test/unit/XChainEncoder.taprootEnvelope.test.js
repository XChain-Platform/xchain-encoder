// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The Taproot envelope encoding (encoding:"TAPROOT"), unit-only.
// Covers the §3.2 grammar (pinned against the golden vector in
// xchain-documentation/protocol/test-vectors/taproot_envelope.json), the
// commit/reveal pair construction, the §3.5 rules (segwit-only inputs,
// SIGHASH_ALL, reveal input 0 = commit outpoint, prefunding), the §4
// per-encoding ceiling, the §3.6 network gate, and the key-path cancel built
// from the persisted recovery record alone -- including full sign/finalize/
// extract round trips for commit, reveal and cancel.

const assert = require('assert')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../src/XChainEncoder')
const TxSizeEstimator = require('../../src/TxSizeEstimator')
const { ENVELOPE_MAX_PAYLOAD, MAX_COMPILED_ACTION_DATA_LENGTH, MAX_STANDARD_TX_WEIGHT } = require('../../src/validator')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

// Deterministic caller key; the compressed pubkey doubles as the envelope
// internal key (x-only = bytes 1..33).
const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY_HEX = Buffer.from(KEY.publicKey).toString('hex')
const XONLY = Buffer.from(KEY.publicKey).subarray(1, 33)

const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)

const TAPROOT_LEAF_VERSION = 0xc0

function makeSegwitUtxo (network, txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network })
  return { txid, vout, value, confirmations: 6, scriptPubKey: p2wpkh.output.toString('hex') }
}

function makeLegacyUtxo (network, txid, vout, value) {
  const p2pkh = bitcoin.payments.p2pkh({ pubkey: Buffer.from(KEY.publicKey), network })
  return { txid, vout, value, confirmations: 6, scriptPubKey: p2pkh.output.toString('hex') }
}

function makeEncoder (networkName = 'bitcoin-regtest') {
  const encoder = new XChainEncoder(networkName, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001, // 1 sat/byte
    getTransactionHex: async () => { throw new Error('unit test: no node') }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
  }
  return encoder
}

function callerAddress (network) {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network }).address
}

// Extract the unsigned tx from a PSBT (what the network will see for a
// segwit-only transaction, minus witnesses).
function unsignedTx (psbt) {
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
}

// Decompile helper: returns the envelope script's chunks between the format
// byte and OP_ENDIF, i.e. the payload pushes.
function payloadPushes (envelopeScript) {
  const d = bitcoin.script.decompile(envelopeScript)
  const endifIndex = d.lastIndexOf(bitcoin.opcodes.OP_ENDIF)
  return d.slice(4, endifIndex)
}

describe('XChainEncoder TAPROOT envelope', function () {
  describe('prepareData grammar (§3.2)', function () {
    const encoder = makeEncoder()

    it('emits OP_FALSE OP_IF <XCHN> <0x00> <payload..> OP_ENDIF <xonly> OP_CHECKSIG', function () {
      const payload = bitcoin.script.compile([Buffer.from('FILE|0|test', 'utf8'), Buffer.from('hello world', 'binary')])
      const prepared = encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network), PUBKEY_HEX)
      assert.strictEqual(prepared.encoding, 'TAPROOT')
      assert.strictEqual(prepared.dataBufferArray.length, 1, 'exactly one envelope script')
      const d = bitcoin.script.decompile(prepared.dataBufferArray[0])
      assert.strictEqual(d[0], bitcoin.opcodes.OP_0, 'OP_FALSE head')
      assert.strictEqual(d[1], bitcoin.opcodes.OP_IF)
      assert.deepStrictEqual(d[2], Buffer.from('XCHN', 'utf8'), 'cleartext magic')
      assert.deepStrictEqual(d[3], Buffer.from([0x00]), 'format byte v0, a real 1-byte push')
      assert.strictEqual(d[d.length - 3], bitcoin.opcodes.OP_ENDIF)
      assert.deepStrictEqual(d[d.length - 2], XONLY, 'internal x-only pubkey')
      assert.strictEqual(d[d.length - 1], bitcoin.opcodes.OP_CHECKSIG)
      // The reassembled payload is byte-identical to the compiled stream.
      assert.deepStrictEqual(Buffer.concat(payloadPushes(prepared.dataBufferArray[0])), payload)
    })

    it('splits the payload into 520-byte pushes, in order', function () {
      const raw = crypto.randomBytes(1500).toString('binary')
      const payload = bitcoin.script.compile([Buffer.from('FILE|0|big', 'utf8'), Buffer.from(raw, 'binary')])
      const prepared = encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network), PUBKEY_HEX)
      const pushes = payloadPushes(prepared.dataBufferArray[0])
      assert.ok(pushes.length >= 3)
      for (let i = 0; i < pushes.length - 1; i++) {
        assert.strictEqual(pushes[i].length, 520, `push ${i} is a full 520-byte element`)
      }
      assert.deepStrictEqual(Buffer.concat(pushes), payload, 'byte-identical reassembly')
    })

    it('rebalances a degenerate 1-byte minimal-opcode final chunk (compile would canonicalize it away)', function () {
      // Build a payload whose length ≡ 1 (mod 520) and whose final byte is in
      // the minimal-op range 0x01-0x10.
      const target = 520 * 2 + 1
      let payload = null
      for (let rawLen = target - 20; rawLen < target; rawLen++) {
        const raw = Buffer.alloc(rawLen, 0x41)
        raw[rawLen - 1] = 0x07 // minimal-op range
        const compiled = bitcoin.script.compile([Buffer.from('FILE|0|x', 'utf8'), raw])
        if (compiled.length % 520 === 1 && compiled[compiled.length - 1] === 0x07) {
          payload = compiled
          break
        }
      }
      assert.ok(payload, 'constructed a payload with a degenerate final chunk')
      const prepared = encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network), PUBKEY_HEX)
      const pushes = payloadPushes(prepared.dataBufferArray[0])
      for (const p of pushes) {
        assert.ok(Buffer.isBuffer(p), 'no push canonicalized to a bare opcode')
        assert.ok(p.length >= 2, 'every push at least 2 bytes after rebalance')
      }
      assert.deepStrictEqual(Buffer.concat(pushes), payload, 'reassembly is still byte-identical')
    })

    it('requires compressedPubKey and validates its shape', function () {
      const payload = bitcoin.script.compile([Buffer.from('FILE|0|test', 'utf8')])
      assert.throws(() => encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network)),
        /compressedPubKey is required for TAPROOT/)
      assert.throws(() => encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network), '04' + 'ab'.repeat(64)),
        /66-character hex string starting with 02 or 03/)
    })

    it('matches the golden grammar vector', function () {
      const vectors = require('../../../xchain-documentation/protocol/test-vectors/taproot_envelope.json')
      const v = vectors.envelope_grammar
      const payload = Buffer.from(v.compiled_payload_hex, 'hex')
      const prepared = encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network), v.internal_pubkey_compressed)
      assert.strictEqual(prepared.dataBufferArray[0].toString('hex'), v.envelope_script_hex, 'golden envelope bytes')
    })
  })

  describe('createTransaction pair construction (§3.5/§6)', function () {
    it('returns {commit psbt, revealPsbt, envelope} with the commit output at vout 0', async function () {
      const encoder = makeEncoder()
      const network = encoder.network
      const utxos = [makeSegwitUtxo(network, TXID_A, 0, 10000000)]
      const raw = crypto.randomBytes(9000).toString('binary') // over the legacy 8192 ceiling on purpose
      const result = await encoder.createTransaction(
        utxos, callerAddress(network), null, 'FILE|0|envelope-test', raw,
        null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)

      assert.strictEqual(result.encoding, 'TAPROOT')
      assert.ok(result.revealPsbt, 'reveal PSBT present')
      assert.ok(result.envelope, 'envelope recovery record present')
      assert.ok(Array.isArray(result.carrierScripts) && result.carrierScripts.length === 1)

      const commitTx = unsignedTx(result.psbt)
      // vout 0 is the P2TR commit output committing to the envelope script.
      const envelopeScript = Buffer.from(result.carrierScripts[0], 'hex')
      const expected = bitcoin.payments.p2tr({
        internalPubkey: XONLY, scriptTree: { output: envelopeScript }, network
      }).output
      assert.strictEqual(result.envelope.commitVout, 0)
      assert.deepStrictEqual(commitTx.outs[0].script, expected)
      assert.strictEqual(commitTx.outs[0].value, result.envelope.commitValue)
      assert.strictEqual(result.envelope.commitTxid, commitTx.getId())

      // Reveal input 0 is the commit outpoint, with the tapLeafScript attached.
      const revealIn = result.revealPsbt.txInputs[0]
      assert.strictEqual(Buffer.from(revealIn.hash).reverse().toString('hex'), commitTx.getId())
      assert.strictEqual(revealIn.index, 0)
      const tapLeaf = result.revealPsbt.data.inputs[0].tapLeafScript[0]
      assert.strictEqual(tapLeaf.leafVersion, TAPROOT_LEAF_VERSION)
      assert.deepStrictEqual(tapLeaf.script, envelopeScript)
      assert.strictEqual(tapLeaf.controlBlock.toString('hex'), result.envelope.controlBlock)

      // §3.5: every commit input carries an explicit SIGHASH_ALL.
      for (const input of result.psbt.data.inputs) {
        assert.strictEqual(input.sighashType, bitcoin.Transaction.SIGHASH_ALL)
      }

      // Prefund arithmetic: commit value = reveal fee + dust change (no LTC pad on BTC).
      assert.strictEqual(result.envelope.commitValue, result.envelope.revealFee + encoder.dustAmount)
      const revealOut = result.revealPsbt.txOutputs[0]
      assert.strictEqual(Number(revealOut.value), encoder.dustAmount, 'reveal change lands exactly at dust')
    })

    it('emits customOutputs on the COMMIT (fee-destination outputs ride the commit, §3.5)', async function () {
      const encoder = makeEncoder()
      const network = encoder.network
      const feeDest = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network }).address
      const utxos = [makeSegwitUtxo(network, TXID_A, 0, 10000000)]
      const result = await encoder.createTransaction(
        utxos, callerAddress(network), [{ address: feeDest, value: 12345 }],
        'FILE|0|feeout', 'x'.repeat(200),
        null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)
      const commitTx = unsignedTx(result.psbt)
      // vout 0 = envelope commit; the custom output follows it on the commit.
      const found = commitTx.outs.slice(1).some(o => o.value === 12345)
      assert.ok(found, 'custom output present on the commit after the envelope output')
      // ...and the reveal carries no custom outputs (change/pad only).
      for (const out of result.revealPsbt.txOutputs) {
        assert.notStrictEqual(Number(out.value), 12345)
      }
    })

    it('refuses non-segwit commit inputs (§3.5, fail closed)', async function () {
      const encoder = makeEncoder()
      const network = encoder.network
      const utxos = [makeLegacyUtxo(network, TXID_A, 0, 10000000)]
      await assert.rejects(
        encoder.createTransaction(
          utxos, callerAddress(network), null, 'FILE|0|legacy', 'x'.repeat(100),
          null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX),
        /TAPROOT commit inputs must be native-segwit/)
    })

    it('refuses TAPROOT on DOGE with the P2WSH gate error shape (§3.6)', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      await assert.rejects(
        encoder.createTransaction(
          [makeSegwitUtxo(bitcoin.networks.regtest, TXID_A, 0, 10000000)],
          callerAddress(bitcoin.networks.regtest), null, 'FILE|0|doge', 'x'.repeat(100),
          null, false, 'TAPROOT', null, null, null, PUBKEY_HEX),
        /TAPROOT encoding is not supported on this network \(no segwit support\)/)
    })

    it('refuses the p2shHash reveal flow for TAPROOT', async function () {
      const encoder = makeEncoder()
      const network = encoder.network
      await assert.rejects(
        encoder.createTransaction(
          [makeSegwitUtxo(network, TXID_A, 0, 10000000)], callerAddress(network), null,
          'FILE|0|x', 'y'.repeat(100), null, false, 'TAPROOT', null,
          TXID_B, 'deadbeef', PUBKEY_HEX),
        /TAPROOT encoding does not use the p2shHash reveal flow/)
    })

    it('applies the per-encoding §4 ceiling: over ENVELOPE_MAX_PAYLOAD rejects, over 8192 passes', async function () {
      const encoder = makeEncoder()
      const network = encoder.network
      // Over the envelope ceiling: rejected with the envelope-specific message.
      const tooBig = 'z'.repeat(ENVELOPE_MAX_PAYLOAD + 10)
      await assert.rejects(
        encoder.createTransaction(
          [makeSegwitUtxo(network, TXID_A, 0, 1000000000)], callerAddress(network), null,
          'FILE|0|big', tooBig, null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX),
        /TAPROOT envelope payload ceiling/)
      // Comfortably over the legacy ceiling but under the envelope one: builds.
      const big = 'z'.repeat(MAX_COMPILED_ACTION_DATA_LENGTH * 2)
      const result = await encoder.createTransaction(
        [makeSegwitUtxo(network, TXID_A, 0, 1000000000)], callerAddress(network), null,
        'FILE|0|big', big, null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)
      assert.ok(result.revealPsbt)
    })

    // The ceiling is DERIVED from MAX_STANDARD_TX_WEIGHT, so the
    // derivation itself needs a test: a payload at exactly the ceiling must
    // still build a reveal a node will relay. The original 400,000 passed every
    // validator-level boundary test while producing a 402,789 WU reveal that no
    // node accepts, because nothing measured the thing that actually binds. A
    // byte-count assertion cannot catch that; only weight can.
    it('a payload at exactly the ceiling builds a reveal within MAX_STANDARD_TX_WEIGHT (§4)', async function () {
      this.timeout(30000)
      const encoder = makeEncoder()
      const network = encoder.network
      // Size rawData so the COMPILED payload lands exactly on the ceiling
      // (action push + OP_PUSHDATA4 framing are part of the measurand), rather
      // than hardcoding an offset that silently drifts if either changes.
      const action = 'FILE|0|max'
      const frame = (n) => bitcoin.script.compile(
        [Buffer.from(action, 'utf8'), Buffer.alloc(n, 0x7a)]).length - n
      const rawLen = ENVELOPE_MAX_PAYLOAD - frame(ENVELOPE_MAX_PAYLOAD)
      assert.strictEqual(
        bitcoin.script.compile([Buffer.from(action, 'utf8'), Buffer.alloc(rawLen, 0x7a)]).length,
        ENVELOPE_MAX_PAYLOAD, 'payload sized exactly to the ceiling')

      const result = await encoder.createTransaction(
        [makeSegwitUtxo(network, TXID_A, 0, 1000000000)], callerAddress(network), null,
        action, 'z'.repeat(rawLen), null, false, 'TAPROOT',
        callerAddress(network), null, null, PUBKEY_HEX)

      // Measure a FULLY SIGNED reveal. An unsigned PSBT carries no witness, and
      // the payload lives entirely in the witness, so weighing the unsigned tx
      // reports ~1/1000th of the truth and would pass at any ceiling.
      result.psbt.signAllInputs({
        publicKey: Buffer.from(KEY.publicKey),
        sign: (h) => Buffer.from(KEY.sign(h))
      })
      result.psbt.finalizeAllInputs()
      result.revealPsbt.signInput(0, {
        publicKey: Buffer.from(KEY.publicKey),
        signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, KEY.privateKey))
      })
      result.revealPsbt.finalizeAllInputs()
      const revealTx = result.revealPsbt.extractTransaction()

      const weight = revealTx.weight()
      assert.strictEqual(revealTx.ins[0].witness.length, 3, 'sig + envelope script + control block')
      assert.ok(weight <= MAX_STANDARD_TX_WEIGHT,
        `reveal weight ${weight} must not exceed MAX_STANDARD_TX_WEIGHT ${MAX_STANDARD_TX_WEIGHT}`)
      // Margin, not a bare pass: the §3.5 extra reveal inputs/outputs and a
      // larger (P2TR) change output must all still fit under the limit.
      assert.ok(MAX_STANDARD_TX_WEIGHT - weight >= 2000,
        `only ${MAX_STANDARD_TX_WEIGHT - weight} WU of headroom at the ceiling; lower ENVELOPE_MAX_PAYLOAD`)
    })

    it('propagates RBF to both transactions of the pair', async function () {
      const encoder = makeEncoder()
      const network = encoder.network
      const result = await encoder.createTransaction(
        [makeSegwitUtxo(network, TXID_A, 0, 10000000)], callerAddress(network), null,
        'FILE|0|rbf', 'x'.repeat(100), null, true, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)
      assert.strictEqual(result.psbt.txInputs[0].sequence, 0x00000001)
      assert.strictEqual(result.revealPsbt.txInputs[0].sequence, 0x00000001)
    })

    it('pads the reveal over the LTC stripped-size floor and prefunds the pad (§3.5)', async function () {
      const encoder = makeEncoder('litecoin-regtest')
      const network = encoder.network
      const result = await encoder.createTransaction(
        [makeSegwitUtxo(network, TXID_A, 0, 100000000)], callerAddress(network), null,
        'FILE|0|ltc', 'x'.repeat(300), null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)
      // p2wpkh change output (31 B) leaves the stripped reveal at 82 B, under
      // LTC's 85-byte floor: expect change + one dust pad output.
      assert.strictEqual(result.revealPsbt.txOutputs.length, 2, 'change + floor pad')
      assert.strictEqual(Number(result.revealPsbt.txOutputs[1].value), encoder.dustAmount)
      assert.strictEqual(result.envelope.commitValue,
        result.envelope.revealFee + 2 * encoder.dustAmount, 'pad dust prefunded on the commit')
      // The padded reveal now clears the floor.
      const stripped = 10 + 41 * result.revealPsbt.txInputs.length +
        result.revealPsbt.txOutputs.reduce((a, o) => a + 8 + 1 + o.script.length, 0)
      assert.ok(stripped >= network.minStandardTxNonWitnessSize)
    })
  })

  describe('sign/finalize/extract round trip (commit -> reveal -> estimator accuracy)', function () {
    it('signs both halves; the signed commit txid matches the pre-built reveal outpoint', async function () {
      const encoder = makeEncoder()
      const network = encoder.network
      const utxos = [makeSegwitUtxo(network, TXID_A, 0, 10000000)]
      const raw = crypto.randomBytes(4000).toString('binary')
      const result = await encoder.createTransaction(
        utxos, callerAddress(network), null, 'FILE|0|sign-test', raw,
        null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)

      // Sign the commit (ordinary p2wpkh inputs, SIGHASH_ALL as instructed).
      const signer = {
        publicKey: Buffer.from(KEY.publicKey),
        sign: (h) => Buffer.from(KEY.sign(h))
      }
      result.psbt.signAllInputs(signer)
      result.psbt.finalizeAllInputs()
      const commitTx = result.psbt.extractTransaction()
      assert.strictEqual(commitTx.getId(), result.envelope.commitTxid,
        'signing did not move the segwit-only commit txid')

      // Sign the reveal via the script path with the internal key.
      const revealSigner = {
        publicKey: Buffer.from(KEY.publicKey),
        signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, KEY.privateKey))
      }
      result.revealPsbt.signInput(0, revealSigner)
      result.revealPsbt.finalizeAllInputs()
      const revealTx = result.revealPsbt.extractTransaction()

      // Witness stack: [schnorr sig, envelope script, control block].
      const witness = revealTx.ins[0].witness
      assert.strictEqual(witness.length, 3)
      assert.strictEqual(witness[1].toString('hex'), result.carrierScripts[0])
      assert.strictEqual(witness[2].toString('hex'), result.envelope.controlBlock)
      assert.strictEqual(Buffer.from(revealTx.ins[0].hash).reverse().toString('hex'), commitTx.getId())

      // The schnorr signature verifies against the leaf sighash.
      const leafHash = bitcoin.crypto.taggedHash('TapLeaf', Buffer.concat([
        Buffer.from([TAPROOT_LEAF_VERSION]),
        // compactSize prefix of the script length (script < 65536 here -> 0xfd form or single byte)
        (function (n) {
          if (n < 253) return Buffer.from([n])
          const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b
        })(witness[1].length),
        witness[1]
      ]))
      assert.strictEqual(leafHash.toString('hex'), result.envelope.tapleafHash)
      const sighash = revealTx.hashForWitnessV1(
        0, [commitTx.outs[0].script], [commitTx.outs[0].value],
        bitcoin.Transaction.SIGHASH_DEFAULT, leafHash)
      assert.ok(ecc.verifySchnorr(sighash, XONLY, witness[0]), 'schnorr signature verifies')

      // Estimator accuracy: the funded reveal fee covers the actual vsize at
      // the quoted 1 sat/vB and does not over-fund by more than the margin.
      const actualVsize = revealTx.virtualSize()
      assert.ok(result.envelope.revealFee >= actualVsize,
        `reveal prefund ${result.envelope.revealFee} covers actual vsize ${actualVsize}`)
      assert.ok(result.envelope.revealFee <= actualVsize + 16,
        `reveal prefund ${result.envelope.revealFee} within margin of actual ${actualVsize}`)
    })
  })

  describe('key-path cancel from the persisted recovery record (§3.5/§3.7)', function () {
    it('builds, signs and extracts a sweep using only the recovery record', async function () {
      const encoder = makeEncoder()
      const network = encoder.network

      // 1. Build the pair and capture ONLY what the wallet persists.
      const result = await encoder.createTransaction(
        [makeSegwitUtxo(network, TXID_A, 0, 10000000)], callerAddress(network), null,
        'FILE|0|cancel-test', crypto.randomBytes(2000).toString('binary'),
        null, false, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)
      const record = {
        commitTxid: result.envelope.commitTxid,
        commitVout: result.envelope.commitVout,
        commitValue: result.envelope.commitValue,
        internalPubkey: result.envelope.internalPubkey,
        tapleafHash: result.envelope.tapleafHash
      }

      // 2. Simulated crash: a fresh encoder builds the cancel from the record.
      const encoder2 = makeEncoder()
      const dest = callerAddress(network)
      const cancel = await encoder2.createEnvelopeCancelTransaction(
        Object.assign({ destination: dest }, record))
      assert.strictEqual(cancel.encoding, 'TAPROOT')
      assert.strictEqual(cancel.cancel, true)

      // The reconstructed input spends the commit outpoint with the real
      // commit scriptPubKey (recomputed from internal key + merkle root).
      const commitTx = unsignedTx(result.psbt)
      assert.deepStrictEqual(cancel.psbt.data.inputs[0].witnessUtxo.script, commitTx.outs[0].script)
      assert.strictEqual(
        Buffer.from(cancel.psbt.txInputs[0].hash).reverse().toString('hex'), record.commitTxid)

      // 3. Key-path sign with the BIP341-tweaked key, as a wallet would.
      const tweaked = KEY.tweak(bitcoin.crypto.taggedHash('TapTweak',
        Buffer.concat([XONLY, Buffer.from(record.tapleafHash, 'hex')])))
      cancel.psbt.signInput(0, {
        publicKey: Buffer.from(tweaked.publicKey),
        signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, tweaked.privateKey))
      })
      cancel.psbt.finalizeAllInputs()
      const cancelTx = cancel.psbt.extractTransaction()
      assert.strictEqual(cancelTx.ins[0].witness.length, 1, 'key-path spend: single witness item')

      // The signature verifies against the commit's tweaked output key.
      const outputKey = commitTx.outs[0].script.subarray(2)
      const sighash = cancelTx.hashForWitnessV1(
        0, [commitTx.outs[0].script], [record.commitValue], bitcoin.Transaction.SIGHASH_DEFAULT)
      assert.ok(ecc.verifySchnorr(sighash, outputKey, cancelTx.ins[0].witness[0]))

      // Sweep value arithmetic: commit value minus the funded fee.
      assert.strictEqual(Number(cancelTx.outs[0].value), record.commitValue - cancel.fee)
    })

    it('fails closed when the sweep would land under dust', async function () {
      const encoder = makeEncoder()
      await assert.rejects(
        encoder.createEnvelopeCancelTransaction({
          commitTxid: TXID_A, commitVout: 0, commitValue: 600,
          internalPubkey: PUBKEY_HEX, tapleafHash: 'c'.repeat(64),
          destination: callerAddress(encoder.network)
        }),
        (err) => err.xchainCode === 'ENVELOPE_CANCEL_BELOW_DUST')
    })

    it('validates the recovery-record fields', async function () {
      const encoder = makeEncoder()
      const base = {
        commitTxid: TXID_A, commitVout: 0, commitValue: 100000,
        internalPubkey: PUBKEY_HEX, tapleafHash: 'c'.repeat(64),
        destination: callerAddress(encoder.network)
      }
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { commitTxid: 'xyz' })), /commitTxid/)
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { commitVout: -1 })), /commitVout/)
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { internalPubkey: '04' + 'a'.repeat(128) })), /internalPubkey/)
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { tapleafHash: 'nope' })), /tapleafHash/)
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { destination: '' })), /destination/)
      // The 100-char shared address cap, which this path used to miss because
      // it is the one create path api.js does not route through validateAll.
      // Uncapped, a multi-megabyte destination under the 3 MB body limit reaches
      // bs58check's quadratic decode on a single-instance service.
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { destination: 'a'.repeat(101) })),
        (err) => err instanceof TypeError && /destination exceeds maximum length \(100\)/.test(err.message))
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { destination: 'a'.repeat(3_000_000) })),
        (err) => err instanceof TypeError && /destination exceeds maximum length \(100\)/.test(err.message))
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { destination: 12345 })),
        (err) => err instanceof TypeError && /destination must be a non-empty string/.test(err.message))
    })

    it('applies the create_tx fee guards to feePerKb and replacebyfee', async function () {
      const encoder = makeEncoder()
      const base = {
        commitTxid: TXID_A, commitVout: 0, commitValue: 100000,
        internalPubkey: PUBKEY_HEX, tapleafHash: 'c'.repeat(64),
        destination: callerAddress(encoder.network)
      }
      // Unguarded, these spellings became NaN, skipped both dust comparisons
      // and surfaced as an opaque internal error instead of invalid-params.
      for (const bad of ['abc', '0x20', '1e3', 'Infinity']) {
        await assert.rejects(encoder.createEnvelopeCancelTransaction(
          Object.assign({}, base, { feePerKb: bad })), TypeError,
          'feePerKb ' + bad + ' must be rejected as a typed error')
      }
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { feePerKb: -1 })), RangeError)
      // The JSON string 'false' is truthy, so it used to arm RBF silently.
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { replacebyfee: 'false' })), /replacebyfee/)
      // Valid shapes still build, and a real boolean still arms RBF.
      const armed = await encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { feePerKb: 5000, replacebyfee: true }))
      assert.strictEqual(armed.psbt.txInputs[0].sequence, 0x00000001)
      const plain = await encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { feePerKb: '5000' }))
      assert.strictEqual(plain.psbt.txInputs[0].sequence, 0xffffffff)
    })

    it('accepts the x-only internal key form', async function () {
      const encoder = makeEncoder()
      const cancel = await encoder.createEnvelopeCancelTransaction({
        commitTxid: TXID_A, commitVout: 0, commitValue: 100000,
        internalPubkey: XONLY.toString('hex'), tapleafHash: 'c'.repeat(64),
        destination: callerAddress(encoder.network)
      })
      assert.deepStrictEqual(cancel.psbt.data.inputs[0].tapInternalKey, XONLY)
    })
  })

  describe('TxSizeEstimator envelope sizing', function () {
    it('estimateEnvelopeRevealTx covers and does not wildly over-fund a real reveal', function () {
      // Direct sanity independent of the encoder round trip above: a
      // ~10 KB envelope script with one p2tr-sized output.
      const est = TxSizeEstimator.estimateEnvelopeRevealTx(10000, 43, 65)
      // nonwitness 10+41+43 = 94; witness 2+1+66+3+10000+34 -> /4 ≈ 2527; +2
      assert.ok(est > 2600 && est < 2700, `estimate ${est} in the expected band`)
    })
    it('estimateTaprootOutput matches the serialized P2TR output size', function () {
      assert.strictEqual(TxSizeEstimator.estimateTaprootOutput(), 43)
    })
    it('uses compactSize framing for scripts above 65535 bytes (5-byte prefix band)', function () {
      const below = TxSizeEstimator.estimateEnvelopeRevealTx(65535, 43, 65)
      const above = TxSizeEstimator.estimateEnvelopeRevealTx(65536, 43, 65)
      // +1 script byte and +2 varint bytes, ÷4 and ceiled: at most +1 vbyte step.
      assert.ok(above >= below, 'monotonic across the varint band switch')
    })
  })
})
