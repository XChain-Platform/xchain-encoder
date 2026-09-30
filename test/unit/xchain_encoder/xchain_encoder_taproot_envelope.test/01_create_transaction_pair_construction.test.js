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

const assert = require('assert')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../../../src/XChainEncoder')
const { ENVELOPE_MAX_PAYLOAD, MAX_COMPILED_ACTION_DATA_LENGTH, MAX_STANDARD_TX_WEIGHT } = require('../../../../src/common/validator')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

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
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
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

describe('XChainEncoder TAPROOT envelope', function () {
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
  })
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('createTransaction pair construction (§3.5/§6)', function () {

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
  })
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('createTransaction pair construction (§3.5/§6)', function () {

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
  })
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('createTransaction pair construction (§3.5/§6)', function () {

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
  })
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('createTransaction pair construction (§3.5/§6)', function () {

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
  })
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('createTransaction pair construction (§3.5/§6)', function () {

    it('propagates RBF to both transactions of the pair', async function () {
      const encoder = makeEncoder()
      const network = encoder.network
      const result = await encoder.createTransaction(
        [makeSegwitUtxo(network, TXID_A, 0, 10000000)], callerAddress(network), null,
        'FILE|0|rbf', 'x'.repeat(100), null, true, 'TAPROOT', callerAddress(network), null, null, PUBKEY_HEX)
      assert.strictEqual(result.psbt.txInputs[0].sequence, 0xfffffffd)
      assert.strictEqual(result.revealPsbt.txInputs[0].sequence, 0xfffffffd)
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
})
