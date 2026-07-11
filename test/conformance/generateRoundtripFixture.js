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
// Generator for the shared encoder->decoder roundtrip conformance fixture
// (). Emits test/fixtures/roundtrip-conformance.json, the single
// golden artifact consumed by BOTH the encoder suite (drift guard) and the
// decoder suite (real-decoder decode of encoder-built bytes). Regenerate with:
//   node test/conformance/generateRoundtripFixture.js
// and review the diff. The fixture is deterministic: bitcoin.script.compile and
// the AES-128-CTR obfuscation are pure functions of their inputs.
//
// It pins the exact byte path where two shipped cross-service bugs lived:
//   #1293 rawData-only  -> compile([<empty>, rawData]) emits a leading OP_0 the
//                          decoder's Buffer gate discards (fee-paid data lost).
//   #1226 1-byte minimal-op payload -> compile canonicalizes a lone 0x01-0x10 /
//                          0x81 byte to a bare opcode the decoder discards.
// Both are captured as `gate: "dropped"` cases so the fixture has teeth: when
// the flag-day decoder-acceptance change lands, those expectations flip and the
// conformance test forces the fixture to be updated in lockstep.

'use strict'

const fs = require('fs')
const path = require('path')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')

const MAGIC_WORD = 'XCHN'
const MAGIC_BUFFER = Buffer.from(MAGIC_WORD, 'utf8')

// A deterministic 64-hex "first input txid" used as the obfuscation key.
const FIRST_INPUT_TXID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00'

// Mirrors XChainEncoder.createTransaction: data is UTF-8, rawData is Latin-1,
// and the on-wire ACTION push is bitcoin.script.compile([dataBuf, rawDataBuf?]).
function compileAction (data, rawData) {
  const dataBuffer = Buffer.from(data == null ? '' : data, 'utf8')
  const toCompile = [dataBuffer]
  if (rawData != null) toCompile.push(Buffer.from(rawData, 'binary'))
  return bitcoin.script.compile(toCompile)
}

// The OP_RETURN wire payload as prepareData + the obfuscation step build it:
// MAGIC_WORD prepended to the compiled ACTION push, then AES-128-CTR obfuscated
// under the first input's txid.
async function buildObfuscatedOpReturn (encoder, compiled) {
  const withMagic = Buffer.concat([MAGIC_BUFFER, compiled])
  return encoder.obfuscate(withMagic, FIRST_INPUT_TXID)
}

// The decoder's documented arbiter gate (XChainDecoder.js ~689-718): the leading
// decompiled element must be a Buffer or the whole payload is discarded; the
// second element is only taken as rawData when it too is a Buffer.
function gateOutcome (compiled) {
  const decompiled = bitcoin.script.decompile(compiled)
  if (decompiled == null || decompiled.length === 0) return { gate: 'dropped', data: null, rawData: null }
  if (!Buffer.isBuffer(decompiled[0])) return { gate: 'dropped', data: null, rawData: null }
  const data = decompiled[0]
  let rawData = null
  if (decompiled.length > 1 && Buffer.isBuffer(decompiled[1])) rawData = decompiled[1]
  return { gate: 'accepted', data, rawData }
}

const CASES = [
  { name: 'action-only (SEND)', data: '{"op":"SEND","qty":100}', rawData: null },
  { name: 'action + rawData (ISSUE + metadata)', data: 'ISSUE|0|TICK', rawData: 'extra-metadata-bytes' },
  { name: 'action + binary rawData (high bytes)', data: 'FILE|0|doc', rawData: '\x00\x01\xff\x80\x7f' },
  { name: 'rawData-only OP_0 leading push (#1293, currently dropped)', data: '', rawData: 'orphan-raw-payload' },
  { name: '1-byte minimal-op data 0x05 (#1226, currently dropped)', data: '\x05', rawData: null },
  { name: '1-byte non-minimal data 0x41 (safe single push)', data: 'A', rawData: null },
  { name: 'empty data-only (payment-only / no-ACTION, OP_0)', data: '', rawData: null }
]

async function main () {
  const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  const cases = []
  for (const c of CASES) {
    const compiled = compileAction(c.data, c.rawData)
    const obfuscated = await buildObfuscatedOpReturn(encoder, compiled)
    const outcome = gateOutcome(compiled)
    cases.push({
      name: c.name,
      encoding: 'OP_RETURN',
      firstInputTxid: FIRST_INPUT_TXID,
      // Inputs (hex) so the fixture is language/encoding-agnostic to consume.
      inputDataHex: Buffer.from(c.data == null ? '' : c.data, 'utf8').toString('hex'),
      inputRawDataHex: c.rawData == null ? null : Buffer.from(c.rawData, 'binary').toString('hex'),
      // Encoder-built artifacts.
      compiledHex: compiled.toString('hex'),
      obfuscatedOpReturnHex: obfuscated.toString('hex'),
      // Expected decode outcome under the decoder's arbiter gate.
      expected: {
        gate: outcome.gate,
        dataHex: outcome.data == null ? null : outcome.data.toString('hex'),
        rawDataHex: outcome.rawData == null ? null : outcome.rawData.toString('hex')
      }
    })
  }

  const fixture = {
    _comment: 'Shared encoder->decoder roundtrip conformance fixture (). ' +
      'Generated by test/conformance/generateRoundtripFixture.js; regenerate and review on change. ' +
      'Consumed by the encoder drift-guard test and the decoder real-decode conformance test. ' +
      'gate "dropped" cases (#1293, #1226) pin known cross-service data-loss shapes; when the ' +
      'flag-day decoder-acceptance change lands those expectations flip.',
    magicWord: MAGIC_WORD,
    cases
  }

  const outPath = path.join(__dirname, '..', 'fixtures', 'roundtrip-conformance.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n')
  console.log(`wrote ${cases.length} cases to ${outPath}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
