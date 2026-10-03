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

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY_HEX = Buffer.from(KEY.publicKey).toString('hex')
const XONLY = Buffer.from(KEY.publicKey).subarray(1, 33)

const TXID_A = 'a'.repeat(64)

function makeSegwitUtxo (network, txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network })
  return { txid, vout, value, confirmations: 6, scriptPubKey: p2wpkh.output.toString('hex') }
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

function unsignedTx (psbt) {
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
}

describe('XChainEncoder TAPROOT envelope', function () {
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
  })
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('key-path cancel from the persisted recovery record (§3.5/§3.7)', function () {

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
      // A commitVout above the uint32 wire width is a TypeError, which the API maps to -32602.
      for (const bad of [4294967296, 1e300]) {
        await assert.rejects(encoder.createEnvelopeCancelTransaction(
          Object.assign({}, base, { commitVout: bad })),
          (err) => err instanceof TypeError && /commitVout/.test(err.message))
      }
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { internalPubkey: '04' + 'a'.repeat(128) })), /internalPubkey/)
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { tapleafHash: 'nope' })), /tapleafHash/)
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { destination: '' })), /destination/)
      // The shared 100-character address cap also applies to this create path,
      // which api.js does not route through validateAll.
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
  })
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('key-path cancel from the persisted recovery record (§3.5/§3.7)', function () {

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
      // The truthy JSON string 'false' would arm RBF silently without this guard.
      await assert.rejects(encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { replacebyfee: 'false' })), /replacebyfee/)
      // Valid shapes still build, and a real boolean still arms RBF.
      const armed = await encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { feePerKb: 5000, replacebyfee: true }))
      assert.strictEqual(armed.psbt.txInputs[0].sequence, 0xfffffffd)
      const plain = await encoder.createEnvelopeCancelTransaction(
        Object.assign({}, base, { feePerKb: '5000' }))
      assert.strictEqual(plain.psbt.txInputs[0].sequence, 0xffffffff)
    })

    it('rejects a caller fee rate below the size-adjusted relay minimum', async function () {
      const encoder = makeEncoder()
      const base = {
        commitTxid: TXID_A, commitVout: 0, commitValue: 100000,
        internalPubkey: PUBKEY_HEX, tapleafHash: 'c'.repeat(64),
        destination: callerAddress(encoder.network), feePerKb: 1
      }
      await assert.rejects(
        encoder.createEnvelopeCancelTransaction(base),
        (err) => err instanceof RangeError &&
          /feePerKb 1 base units\/kB produces fee \d+, below the node relay minimum \d+ base units/.test(err.message)
      )
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
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('key-path cancel fee-rate cap without a node estimate', function () {
    it('caps a caller feePerKb on the relayfee anchor when the node estimate is unavailable', async function () {
      // No MAX_FEE_RATE_KB, default multiplier 100, relayfee 1 sat/vB: the
      // ceiling is 100 sat/vB, so a 1000 sat/vB request on this ~102-vbyte
      // sweep pays about 10200, not 102000.
      const noEstimate = async () => { throw new Error('Error getting smart fee from node') }
      const base = {
        commitTxid: TXID_A, commitVout: 0, commitValue: 1000000,
        internalPubkey: PUBKEY_HEX, tapleafHash: 'c'.repeat(64)
      }
      const cancelAt = async (encoder, feePerKb) => {
        encoder.connector.getFeePerKilobyte = noEstimate
        const cancel = await encoder.createEnvelopeCancelTransaction(
          Object.assign({ feePerKb, destination: callerAddress(encoder.network) }, base))
        assert.strictEqual(cancel.psbt.txOutputs[0].value, base.commitValue - cancel.fee)
        return cancel.fee
      }
      const hostile = await cancelAt(makeEncoder(), 1000000)
      assert.ok(hostile >= 10100 && hostile <= 10200, 'hostile rate clamped to 100 sat/vB, got ' + hostile)
      // An absolute MAX_FEE_RATE_KB below the relative ceiling still binds.
      const absolute = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 50000)
      absolute.connector = makeEncoder().connector
      const capped = await cancelAt(absolute, 1000000)
      assert.ok(capped >= 5050 && capped <= 5100, 'absolute cap binds at 50 sat/vB, got ' + capped)
      // A legitimate rate under the ceiling is charged as given.
      const fair = await cancelAt(makeEncoder(), 10000)
      assert.ok(fair >= 1010 && fair <= 1020, 'a 10 sat/vB rate is not clamped, got ' + fair)
    })
  })

})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('key-path cancel outpoint shares the create_tx outpoint rule', function () {
    function cancelWith (encoder, commitTxid, commitVout) {
      return encoder.createEnvelopeCancelTransaction({
        commitTxid, commitVout, commitValue: 100000,
        internalPubkey: PUBKEY_HEX, tapleafHash: 'c'.repeat(64),
        destination: callerAddress(encoder.network)
      })
    }

    it('accepts a decimal-string vout and an uppercase txid, building canonical forms', async function () {
      const encoder = makeEncoder()
      const cancel = await cancelWith(encoder, TXID_A.toUpperCase(), '0')
      const input = cancel.psbt.txInputs[0]
      assert.strictEqual(input.index, 0)
      assert.strictEqual(Buffer.from(input.hash).reverse().toString('hex'), TXID_A)
      assert.ok(encoder.outpointReservations.has(TXID_A + ':0'))
    })

    it('keys a zero-padded vout as its integer, so it collides with create_tx', async function () {
      const encoder = makeEncoder()
      await cancelWith(encoder, TXID_A, '01')
      assert.ok(encoder.outpointReservations.has(TXID_A + ':1'))
      assert.ok(!encoder.outpointReservations.has(TXID_A + ':01'))
    })

    it('still rejects every non-integer vout spelling as a typed commitVout error', async function () {
      const encoder = makeEncoder()
      const bad = ['abc', '1.5', '0x1', '1e3', '', null, true, [0], -1, '-1', 4294967296, '4294967296']
      for (const vout of bad) {
        await assert.rejects(cancelWith(encoder, TXID_A, vout),
          (err) => err instanceof TypeError && /commitVout/.test(err.message), 'vout ' + JSON.stringify(vout))
      }
    })
  })
})
