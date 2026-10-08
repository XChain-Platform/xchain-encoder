// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../../src/XChainEncoder')
const { skipOrFail } = require('../../../helpers/sibling_checkout')

const vectorsFile = process.env.TAPROOT_VECTORS_FILE
let vectors
let internalPubkey

function sha256 (buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function makeRawData (length, finalByte) {
  const rawData = Buffer.alloc(length)
  for (let i = 0; i < length; i++) rawData[i] = (i * 7 + 13) & 0xff
  if (finalByte != null) rawData[rawData.length - 1] = finalByte
  return rawData
}

function compilePayload (action, rawData) {
  return bitcoin.script.compile([Buffer.from(action, 'utf8'), rawData])
}

function payloadFor (testCase, vector) {
  if (vector.payload_generation) {
    assert.strictEqual(vector.payload_generation, testCase.payloadGeneration)
    return compilePayload(testCase.action, testCase.rawData)
  }

  const payload = Buffer.alloc(vector.compiled_payload_length, 0x41)
  payload[payload.length - 1] = Number(vector.final_byte)
  return payload
}

function decompileEnvelope (envelopeScript) {
  const decompiled = bitcoin.script.decompile(envelopeScript)
  assert.ok(decompiled, 'envelope script must decompile')
  return decompiled
}

describe('XChainEncoder published Taproot envelope vectors', function () {
  const encoder = new XChainEncoder('bitcoin-regtest', '', '', '', '', '', '')
  const cases = [
    {
      name: 'envelope_chunking',
      action: 'FILE|0|chunks.bin|application/octet-stream|||||||',
      rawData: makeRawData(1200),
      payloadGeneration: 'action "FILE|0|chunks.bin|application/octet-stream|||||||" + 1200 rawData bytes where byte[i] = (i*7+13) & 0xff'
    },
    {
      name: 'chunk_rebalance',
      action: 'FILE|0|rebalance.bin|application/octet-stream|||||||',
      rawData: makeRawData(985, 0x07),
      payloadGeneration: 'action "FILE|0|rebalance.bin|application/octet-stream|||||||" + 985 rawData bytes where byte[i] = (i*7+13) & 0xff for i < 984 and byte[984] = 0x07'
    }
  ]

  before(function () {
    const verdict = {
      usable: Boolean(vectorsFile && fs.existsSync(vectorsFile)),
      reason: vectorsFile
        ? `published vectors file absent: ${vectorsFile}`
        : 'TAPROOT_VECTORS_FILE is not set'
    }

    if (!verdict.usable) {
      return skipOrFail(this, verdict, 'the published Taproot envelope vector checks')
    }

    vectors = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'))
    internalPubkey = vectors.envelope_grammar.internal_pubkey_compressed
  })

  for (const testCase of cases) {
    it(`matches ${testCase.name} through prepareData`, function () {
      const vector = vectors[testCase.name]
      const payload = payloadFor(testCase, vector)

      assert.strictEqual(payload.length, vector.compiled_payload_length)
      if (vector.final_byte) {
        assert.strictEqual(payload.at(-1), Number(vector.final_byte))
      }
      if (vector.payload_generation) {
        assert.strictEqual(sha256(payload), vector.compiled_payload_sha256)
      }

      const prepared = encoder.prepareData(payload, 'TAPROOT', null, internalPubkey)
      assert.strictEqual(prepared.encoding, 'TAPROOT')
      assert.strictEqual(prepared.dataBufferArray.length, 1)
      assert.strictEqual(
        prepared.internalPubkey.toString('hex'),
        vectors.envelope_grammar.internal_pubkey_xonly
      )

      const envelopeScript = prepared.dataBufferArray[0]
      const decompiled = decompileEnvelope(envelopeScript)
      assert.deepStrictEqual(decompiled.slice(0, 4), [
        bitcoin.opcodes.OP_0,
        bitcoin.opcodes.OP_IF,
        Buffer.from('XCHN', 'utf8'),
        Buffer.from([0])
      ])
      assert.strictEqual(decompiled.at(-3), bitcoin.opcodes.OP_ENDIF)
      assert.strictEqual(
        decompiled.at(-2).toString('hex'),
        vectors.envelope_grammar.internal_pubkey_xonly
      )
      assert.strictEqual(decompiled.at(-1), bitcoin.opcodes.OP_CHECKSIG)

      const pushes = decompiled.slice(4, -3)
      assert.ok(pushes.every(Buffer.isBuffer))
      assert.deepStrictEqual(pushes.map((push) => push.length), vector.push_lengths)
      assert.deepStrictEqual(Buffer.concat(pushes), payload)
      if (vector.payload_generation) {
        assert.strictEqual(sha256(envelopeScript), vector.envelope_script_sha256)
      }

      if (vector.envelope_script_length != null) {
        assert.strictEqual(envelopeScript.length, vector.envelope_script_length)
      }
    })
  }
})
