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
// Encoder half of the shared roundtrip conformance fixture. Asserts
// the encoder still produces the golden compiled + obfuscated bytes for every
// case (a drift guard: any change to the compile construction or obfuscation
// step that would desync the decoder fails here) and that bitcoin.script.compile
// canonicalization matches the pinned gate expectation. The decoder half
// (xchain-decoder/test/unit/roundtripConformance.test.js) consumes the SAME
// JSON and feeds these bytes through the real decoder deobfuscation + decompile.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const { ACTION_ALIASES } = require('../../src/validator')
const fixture = require('../fixtures/roundtrip-conformance.json')

const MAGIC_BUFFER = Buffer.from(fixture.magicWord, 'utf8')

function makeEncoder () {
  return new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
}

// Mirrors XChainEncoder.createTransaction: data UTF-8, rawData Latin-1.
function compileAction (dataHex, rawDataHex) {
  const toCompile = [Buffer.from(dataHex, 'hex')]
  if (rawDataHex != null) toCompile.push(Buffer.from(rawDataHex, 'hex'))
  return bitcoin.script.compile(toCompile)
}

describe('roundtrip conformance fixture: encoder emit', () => {
  const encoder = makeEncoder()

  it('has cases', () => assert.ok(fixture.cases.length > 0))

  fixture.cases.forEach((c) => {
    describe(c.name, () => {
      it('compiles to the golden compiledHex', () => {
        const compiled = compileAction(c.inputDataHex, c.inputRawDataHex)
        assert.strictEqual(compiled.toString('hex'), c.compiledHex)
      })

      it('obfuscates the magic-prefixed payload to the golden obfuscatedOpReturnHex', async () => {
        const compiled = Buffer.from(c.compiledHex, 'hex')
        const withMagic = Buffer.concat([MAGIC_BUFFER, compiled])
        const obfuscated = await encoder.obfuscate(withMagic, c.firstInputTxid)
        assert.strictEqual(obfuscated.toString('hex'), c.obfuscatedOpReturnHex)
      })

      it('decompiles to the pinned gate expectation', () => {
        const decompiled = bitcoin.script.decompile(Buffer.from(c.compiledHex, 'hex'))
        const leadingIsBuffer = decompiled != null && decompiled.length > 0 && Buffer.isBuffer(decompiled[0])
        assert.strictEqual(leadingIsBuffer ? 'accepted' : 'dropped', c.expected.gate)
        if (c.expected.gate === 'accepted') {
          assert.strictEqual(decompiled[0].toString('hex'), c.expected.dataHex)
          const rawHex = (decompiled.length > 1 && Buffer.isBuffer(decompiled[1]))
            ? decompiled[1].toString('hex') : null
          assert.strictEqual(rawHex, c.expected.rawDataHex)
        }
      })
    })
  })
})

// Drift guards for the MULTISIGN / P2SH / P2WSH / alias extensions.
// Re-run the REAL encoder chunking primitives (prepareData, obfuscate,
// dataToPubkey) over each case's inputs and require byte-identity with the
// golden artifacts the decoder half consumes.
describe('roundtrip conformance fixture: MULTISIGN emit', () => {
  const encoder = makeEncoder()

  it('has cases', () => assert.ok(fixture.multisignCases.length > 0))

  fixture.multisignCases.forEach((c) => {
    describe(c.name, () => {
      it('prepareData chunks to the golden 64-byte zero-padded slots', () => {
        const compiled = compileAction(c.inputDataHex, c.inputRawDataHex)
        assert.strictEqual(compiled.toString('hex'), c.compiledHex)
        const prepared = encoder.prepareData(compiled, 'MULTISIGN')
        assert.strictEqual(prepared.encoding, 'MULTISIGN')
        assert.strictEqual(prepared.dataBufferArray.length, c.slots.length)
        prepared.dataBufferArray.forEach((slot, i) => {
          assert.strictEqual(slot.length, 64, `slot ${i} must be a full 64-byte slot`)
          assert.strictEqual(slot.toString('hex'), c.slots[i].plaintextSlotHex, `slot ${i}`)
        })
      })

      it('obfuscates and pubkey-packs each slot to the golden output script', async () => {
        for (const [i, s] of c.slots.entries()) {
          const obfuscated = await encoder.obfuscate(Buffer.from(s.plaintextSlotHex, 'hex'), c.firstInputTxid)
          assert.strictEqual(obfuscated.toString('hex'), s.obfuscatedSlotHex, `slot ${i} obfuscation`)
          const pubkey1 = await encoder.dataToPubkey(obfuscated.slice(0, 32))
          const pubkey2 = await encoder.dataToPubkey(obfuscated.slice(32, obfuscated.length))
          assert.strictEqual(pubkey1.toString('hex'), s.pubkey1Hex, `slot ${i} pubkey1`)
          assert.strictEqual(pubkey2.toString('hex'), s.pubkey2Hex, `slot ${i} pubkey2`)
          const output = bitcoin.payments.p2ms({
            m: 1,
            pubkeys: [pubkey1, pubkey2, Buffer.from(c.thirdPubkeyHex, 'hex')],
            network: encoder.network
          }).output
          assert.strictEqual(output.toString('hex'), s.outputScriptHex, `slot ${i} output script`)
        }
      })

      it('magic-stripped slot concatenation matches the golden reassembly', () => {
        const reassembled = Buffer.concat(
          c.slots.map((s) => Buffer.from(s.plaintextSlotHex, 'hex').subarray(MAGIC_BUFFER.length))
        )
        assert.strictEqual(reassembled.toString('hex'), c.reassembledHex)
      })
    })
  })
})

describe('roundtrip conformance fixture: P2SH/P2WSH emit', () => {
  const encoder = makeEncoder()

  it('has cases', () => assert.ok(fixture.p2shCases.length > 0))

  it('covers the 1-byte final-chunk rebalance boundary', () => {
    // At least one case must have hit the rebalance path (final chunk of
    // exactly 2 bytes after a full 476-byte chunk shrank to 475).
    assert.ok(fixture.p2shCases.some((c) =>
      c.chunkLengths.length >= 2 &&
      c.chunkLengths[c.chunkLengths.length - 1] === 2 &&
      c.chunkLengths[c.chunkLengths.length - 2] === 475
    ), 'no case pins the final-chunk rebalance repartition')
  })

  fixture.p2shCases.forEach((c) => {
    describe(c.name, () => {
      it('prepareData chunks to the golden redeem scripts', () => {
        const compiled = compileAction(c.inputDataHex, c.inputRawDataHex)
        assert.strictEqual(compiled.toString('hex'), c.compiledHex)
        const prepared = encoder.prepareData(compiled, c.encoding, c.pubKeyBase58)
        assert.strictEqual(prepared.encoding, c.encoding)
        assert.deepStrictEqual(
          prepared.dataBufferArray.map((b) => b.toString('hex')),
          c.redeemScriptsHex
        )
      })

      it('every chunk push is a Buffer >= 2 bytes (rebalance invariant)', () => {
        c.redeemScriptsHex.forEach((hex, i) => {
          const decompiled = bitcoin.script.decompile(Buffer.from(hex, 'hex'))
          assert.ok(decompiled && Buffer.isBuffer(decompiled[0]),
            `chunk ${i} leading element must be a Buffer, not a canonicalized opcode`)
          assert.ok(decompiled[0].length >= 2, `chunk ${i} must be >= 2 bytes`)
          assert.strictEqual(decompiled[0].length, c.chunkLengths[i], `chunk ${i} length`)
        })
      })

      it('chunk concatenation is byte-identical to the compiled payload', () => {
        const reassembled = Buffer.concat(c.redeemScriptsHex.map((hex) =>
          bitcoin.script.decompile(Buffer.from(hex, 'hex'))[0]
        ))
        assert.strictEqual(reassembled.toString('hex'), c.compiledHex)
      })

      it('emits the golden obfuscated reveal marker', async () => {
        const markerPlain = Buffer.concat([MAGIC_BUFFER, Buffer.from(c.encoding.toLowerCase(), 'utf8')])
        const marker = await encoder.obfuscate(markerPlain, c.firstInputTxid)
        assert.strictEqual(marker.toString('hex'), c.markerOpReturnHex)
      })
    })
  })
})

describe('roundtrip conformance fixture: alias cases emit', () => {
  const encoder = makeEncoder()

  it('has cases', () => assert.ok(fixture.aliasCases.length > 0))

  fixture.aliasCases.forEach((c) => {
    describe(c.name, () => {
      it('compiles and obfuscates to the golden bytes', async () => {
        const compiled = compileAction(c.inputDataHex, null)
        assert.strictEqual(compiled.toString('hex'), c.compiledHex)
        const withMagic = Buffer.concat([MAGIC_BUFFER, compiled])
        const obfuscated = await encoder.obfuscate(withMagic, c.firstInputTxid)
        assert.strictEqual(obfuscated.toString('hex'), c.obfuscatedOpReturnHex)
      })

      it("the encoder validator's alias map agrees with the pinned rewrite", () => {
        // The decoder is what expands aliases on-chain; the encoder pre-check
        // must agree exactly (validator.js ACTION_ALIASES) or the two services
        // disagree about which payloads are valid.
        assert.strictEqual(ACTION_ALIASES[c.expected.rawActionName], c.expected.actionName)
      })
    })
  })
})
