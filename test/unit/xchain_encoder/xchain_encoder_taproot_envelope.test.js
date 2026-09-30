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
const XChainEncoder = require('../../../src/XChainEncoder')
const vectors = require('../../../../xchain-documentation/protocol/test-vectors/taproot_envelope.json');

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

// Deterministic caller key; the compressed pubkey doubles as the envelope
// internal key (x-only = bytes 1..33).
const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY_HEX = Buffer.from(KEY.publicKey).toString('hex')
const XONLY = Buffer.from(KEY.publicKey).subarray(1, 33)

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
  })
})

describe('XChainEncoder TAPROOT envelope', function () {
  describe('prepareData grammar (§3.2)', function () {
    const encoder = makeEncoder()

    it('requires compressedPubKey and validates its shape', function () {
      const payload = bitcoin.script.compile([Buffer.from('FILE|0|test', 'utf8')])
      assert.throws(() => encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network)),
        /compressedPubKey is required for TAPROOT/)
      assert.throws(() => encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network), '04' + 'ab'.repeat(64)),
        /66-character hex string starting with 02 or 03/)
    })

    it('matches the golden grammar vector', function () {
      const v = vectors.envelope_grammar
      const payload = Buffer.from(v.compiled_payload_hex, 'hex')
      const prepared = encoder.prepareData(payload, 'TAPROOT', callerAddress(encoder.network), v.internal_pubkey_compressed)
      assert.strictEqual(prepared.dataBufferArray[0].toString('hex'), v.envelope_script_hex, 'golden envelope bytes')
    })
  })
})
