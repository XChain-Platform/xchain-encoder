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
// Regression: bitcoin.script.compile minimal-op canonicalization drops pushes
// the paired decoder cannot read (). A 1-byte minimal-op-range payload
// (0x01-0x10, 0x81) or a degenerate 1-byte final P2SH/P2WSH chunk canonicalizes
// to a bare opcode the decoder then skips. Fixes are encoder-side:
// validateActionPushDecodability refuses the undecodable single-byte shapes at
// validate time, and prepareData rebalances a degenerate 1-byte final chunk so
// the compiled redeem script never carries a bare-opcode data element.
//
// The empty-data OP_0 rawData-only shape () is intentionally NOT
// touched here: it is a deliberately-supported, tested contract, and restoring
// it end-to-end is a decoder-side (consensus) flag-day change, not an encoder
// refusal. Note `data` is measured as UTF-8, so only bytes 0x01-0x10 are
// reachable as a lone-byte data push (0x81 encodes to 2 UTF-8 bytes); rawData
// is measured as Latin-1, so 0x01-0x10 and 0x81 are all reachable there.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const validator = require('../../src/validator')
const XChainEncoder = require('../../src/XChainEncoder')

const B05 = String.fromCharCode(0x05) // 1-byte 0x05 under both utf8 and latin1
const B0F = String.fromCharCode(0x0f)
const B81 = String.fromCharCode(0x81) // 1 byte under latin1, 2 bytes under utf8

const REGTEST_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'),
  network: bitcoin.networks.regtest
}).address

function makeEncoder () {
  return new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
}

describe('minimal-op canonicalization guards (#1226; #1293 flag-day scoped)', () => {

  describe('compilesToBareOpcode / isMinimalOpSingleByte predicates', () => {
    it('compilesToBareOpcode flags empty (OP_0) and 1-byte minimal-op values', () => {
      assert.strictEqual(validator.compilesToBareOpcode(Buffer.alloc(0)), true)
      for (const b of [0x01, 0x08, 0x10, 0x81]) {
        assert.strictEqual(validator.compilesToBareOpcode(Buffer.from([b])), true, `byte 0x${b.toString(16)}`)
        const decompiled = bitcoin.script.decompile(bitcoin.script.compile([Buffer.from([b])]))
        assert.strictEqual(Buffer.isBuffer(decompiled[0]), false)
      }
    })
    it('isMinimalOpSingleByte excludes the empty buffer (that is the #1293 shape)', () => {
      assert.strictEqual(validator.isMinimalOpSingleByte(Buffer.alloc(0)), false)
      assert.strictEqual(validator.isMinimalOpSingleByte(Buffer.from([0x05])), true)
      assert.strictEqual(validator.isMinimalOpSingleByte(Buffer.from([0x81])), true)
    })
    it('neither predicate flags a single 0x00 byte (compiles to a real 1-byte push)', () => {
      assert.strictEqual(validator.compilesToBareOpcode(Buffer.from([0x00])), false)
      assert.strictEqual(validator.isMinimalOpSingleByte(Buffer.from([0x00])), false)
      const decompiled = bitcoin.script.decompile(bitcoin.script.compile([Buffer.from([0x00])]))
      assert.ok(Buffer.isBuffer(decompiled[0]))
    })
    it('neither predicate flags multi-byte or non-minimal single bytes', () => {
      assert.strictEqual(validator.compilesToBareOpcode(Buffer.from([0x20])), false)
      assert.strictEqual(validator.isMinimalOpSingleByte(Buffer.from([0x11])), false)
      assert.strictEqual(validator.compilesToBareOpcode(Buffer.from('ab', 'utf8')), false)
    })
  })

  describe('validateActionPushDecodability (#1226 single-byte minimal-op drop)', () => {
    it('rejects a 1-byte minimal-op data-only action (0x05, 0x0f)', () => {
      assert.throws(() => validator.validateActionPushDecodability(B05, null), /data/)
      assert.throws(() => validator.validateActionPushDecodability(B0F, null), /data/)
    })
    it('rejects a 1-byte minimal-op rawData push (0x03 and 0x81 via Latin-1)', () => {
      assert.throws(() => validator.validateActionPushDecodability('action', String.fromCharCode(0x03)), /rawData/)
      assert.throws(() => validator.validateActionPushDecodability('action', B81), /rawData/)
    })
    it('accepts a normal two-push action + rawData', () => {
      assert.doesNotThrow(() => validator.validateActionPushDecodability('{"op":"SEND"}', 'file-bytes-here'))
    })
    it('accepts a 1-byte non-minimal data-only action (0x41)', () => {
      assert.doesNotThrow(() => validator.validateActionPushDecodability('A', null))
    })
    it('accepts a normal multi-byte data-only action', () => {
      assert.doesNotThrow(() => validator.validateActionPushDecodability('{"op":"ISSUE"}', null))
    })
  })

  describe('empty-data shapes remain intentionally supported (#1293 is flag-day scoped)', () => {
    it('does NOT reject empty data-only (payment-only / no-ACTION tx)', () => {
      assert.doesNotThrow(() => validator.validateActionPushDecodability('', null))
      assert.doesNotThrow(() => validator.validateActionPushDecodability(null, null))
    })
    it('does NOT reject the deliberately-supported rawData-only shape', () => {
      assert.doesNotThrow(() => validator.validateActionPushDecodability('', 'orphan-raw'))
      assert.doesNotThrow(() => validator.validateActionPushDecodability(null, 'orphan-raw'))
    })
  })

  describe('validateAll wires the guard', () => {
    const base = { pubkey: REGTEST_ADDRESS }
    it('rejects a 1-byte minimal-op data through validateAll with a RangeError', () => {
      assert.throws(() => validator.validateAll({ ...base, data: B05 }), RangeError)
    })
    it('still accepts rawData-only through validateAll', () => {
      assert.doesNotThrow(() => validator.validateAll({ ...base, rawData: 'orphan-raw' }))
    })
  })

  describe('prepareData rebalances a degenerate 1-byte final P2SH/P2WSH chunk (#1226)', () => {
    const encoder = makeEncoder()

    // chunksSize for P2SH/P2WSH is 520 - 44 = 476. A payload of 476*k + 1 bytes
    // whose final byte is a minimal-op value would, unfixed, emit a lone 1-byte
    // final chunk canonicalized to a bare opcode the decoder skips.
    function assertRoundTrips (data, encoding) {
      const { dataBufferArray } = encoder.prepareData(data, encoding, REGTEST_ADDRESS)
      const reassembled = []
      for (const redeem of dataBufferArray) {
        const decompiled = bitcoin.script.decompile(redeem)
        assert.ok(Buffer.isBuffer(decompiled[0]),
          `every redeem-script data element must be a Buffer, got ${typeof decompiled[0]}`)
        reassembled.push(decompiled[0])
      }
      assert.ok(Buffer.concat(reassembled).equals(data),
        'reassembled chunks must equal the original payload byte-for-byte')
    }

    for (const encoding of ['P2SH', 'P2WSH']) {
      it(`${encoding}: 477-byte payload ending in a minimal-op byte (0x05) round-trips`, () => {
        const data = Buffer.concat([Buffer.alloc(476, 0x61), Buffer.from([0x05])])
        assert.strictEqual(data.length, 477)
        assertRoundTrips(data, encoding)
      })
      it(`${encoding}: 477-byte payload ending in 0x81 round-trips`, () => {
        const data = Buffer.concat([Buffer.alloc(476, 0x61), Buffer.from([0x81])])
        assertRoundTrips(data, encoding)
      })
      it(`${encoding}: ordinary multi-chunk payload is unaffected`, () => {
        assertRoundTrips(Buffer.alloc(1000, 0x62), encoding)
      })
      it(`${encoding}: 1-byte-final chunk with a NON-minimal byte still round-trips`, () => {
        const data = Buffer.concat([Buffer.alloc(476, 0x61), Buffer.from([0x20])])
        assertRoundTrips(data, encoding)
      })
    }
  })
})
