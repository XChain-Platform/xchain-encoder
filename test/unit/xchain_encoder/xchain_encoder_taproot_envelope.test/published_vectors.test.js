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

const vectorsFile = process.env.TAPROOT_VECTORS_FILE

if (!vectorsFile) {
  throw new Error('TAPROOT_VECTORS_FILE must point to the published taproot envelope vectors')
}

const vectors = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'))
const internalPubkey = vectors.envelope_grammar.internal_pubkey_compressed

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

function payloadPushes (envelopeScript) {
  const decompiled = bitcoin.script.decompile(envelopeScript)
  return decompiled.slice(4, -3)
}

describe('XChainEncoder published Taproot envelope vectors', function () {
  const encoder = new XChainEncoder('bitcoin-regtest', '', '', '', '', '', '')
  const cases = [
    {
      name: 'envelope_chunking',
      action: 'FILE|0|chunks.bin|application/octet-stream|||||||',
      rawData: makeRawData(1200)
    },
    {
      name: 'chunk_rebalance',
      action: 'FILE|0|rebalance.bin|application/octet-stream|||||||',
      rawData: makeRawData(985, 0x07)
    }
  ]

  for (const testCase of cases) {
    it(`matches ${testCase.name} through prepareData`, function () {
      const vector = vectors[testCase.name]
      const payload = compilePayload(testCase.action, testCase.rawData)

      assert.strictEqual(payload.length, vector.compiled_payload_length)
      assert.strictEqual(sha256(payload), vector.compiled_payload_sha256)

      const prepared = encoder.prepareData(payload, 'TAPROOT', null, internalPubkey)
      assert.strictEqual(prepared.encoding, 'TAPROOT')
      assert.strictEqual(prepared.dataBufferArray.length, 1)

      const envelopeScript = prepared.dataBufferArray[0]
      const pushes = payloadPushes(envelopeScript)
      assert.ok(pushes.every(Buffer.isBuffer))
      assert.deepStrictEqual(pushes.map((push) => push.length), vector.push_lengths)
      assert.deepStrictEqual(Buffer.concat(pushes), payload)
      assert.strictEqual(sha256(envelopeScript), vector.envelope_script_sha256)

      if (vector.envelope_script_length != null) {
        assert.strictEqual(envelopeScript.length, vector.envelope_script_length)
      }
    })
  }
})
