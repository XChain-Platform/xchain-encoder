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
// Encoder half of the shared roundtrip conformance fixture (). Asserts
// the encoder still produces the golden compiled + obfuscated bytes for every
// case (a drift guard: any change to the compile construction or obfuscation
// step that would desync the decoder fails here) and that bitcoin.script.compile
// canonicalization matches the pinned gate expectation. The decoder half
// (xchain-decoder/test/unit/roundtripConformance.test.js) consumes the SAME
// JSON and feeds these bytes through the real decoder deobfuscation + decompile.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
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

describe('roundtrip conformance fixture: encoder emit ()', () => {
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
