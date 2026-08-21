// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression: a caller-supplied UTXO txid carrying uppercase hex could never
// complete an OP_RETURN or MULTISIGN build.
//
// The obfuscation key for those two encodings is the ins[0] txid STRING taken
// verbatim (obfuscate() splits it with substr into the AES-128-CTR key and IV),
// while the decoder derives its half from the wire bytes, which render as
// lowercase hex. 'A' is 0x41 and 'a' is 0x61, so a mixed-case txid produced a
// different key on each side. The validator's HEX_64_RE admits either case, so
// the shape reached the builder, where the fail-closed ins[0] guard compared the
// key-bound string against a lowercase rendering of psbt.txInputs[0].hash and
// threw INPUT_SELECTION_RACE with "retry the request": a deterministic permanent
// failure wearing a transient label, which invites a client to retry forever.
//
// Two normalization points are pinned here because they cover different callers:
// validateUtxoEntry canonicalizes the JSON-RPC and tracker ingest paths, and the
// key-binding site canonicalizes the library caller who reaches createTransaction
// without validateAll.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  makeEncoder, makeSegwitUtxo, getTestAddress, TXID_A
} = require('../integration/helpers/utxoFactory')
const { deobfuscate } = require('../integration/helpers/deobfuscate')
const actions = require('../integration/helpers/actionFactory')
const validator = require('../../src/validator')

const NETWORK = 'dogecoin-regtest'
const MAGIC = 'XCHN'
const COMPRESSED_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function ins0Txid (result) {
  return Buffer.from(result.psbt.txInputs[0].hash).reverse().toString('hex')
}

// Caller-supplied coin control, uppercased. This path does NOT run validateAll,
// so it exercises the encoder-side normalization on its own.
function upperCaseUtxos () {
  return [makeSegwitUtxo(TXID_A.toUpperCase(), 0, 100000000)]
}

describe('uppercase-hex txid / obfuscation-key binding @regression', function () {
  this.timeout(10000)

  it('validateUtxoEntry canonicalizes txid case at ingest', function () {
    const entry = { txid: TXID_A.toUpperCase(), vout: 0, value: 1000, scriptPubKey: 'aa' }
    validator.validateUtxoEntry(entry, 0)
    assert.strictEqual(entry.txid, TXID_A,
      'an accepted txid must be canonical lowercase, because it is used as an AES key')
  })

  it('OP_RETURN: an uppercase caller txid builds and decodes under the ins[0] key', async function () {
    const encoder = makeEncoder(NETWORK)
    const address = getTestAddress(NETWORK)
    const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)

    const result = await encoder.createTransaction(
      upperCaseUtxos(), address, null, action.data, null, 10000, false, null, address,
      null, null, null, true, 0.00001
    )

    assert.strictEqual(ins0Txid(result), TXID_A)
    const opReturn = result.psbt.txOutputs.find(o => o.value === 0)
    const obf = bitcoin.script.decompile(opReturn.script)[1]
    assert.strictEqual(deobfuscate(obf, ins0Txid(result)).subarray(0, 4).toString('utf8'), MAGIC,
      'the action must decode with ins[0].txid, which is the key the decoder uses')
  })

  it('MULTISIGN: same, on the bare-multisig payload path', async function () {
    const encoder = makeEncoder(NETWORK)
    const address = getTestAddress(NETWORK)
    const action = actions.makeSend('JDOG', '7', actions.ADDR_BTC)

    const result = await encoder.createTransaction(
      upperCaseUtxos(), address, null, action.data, null, 10000, false, 'MULTISIGN', address,
      null, null, COMPRESSED_PUBKEY, true, 0.00001
    )

    assert.strictEqual(result.encoding, 'MULTISIGN')
    assert.strictEqual(ins0Txid(result), TXID_A)

    const msOut = result.psbt.txOutputs.find(o => {
      const d = bitcoin.script.decompile(o.script)
      return d && d.length === 6 && Buffer.isBuffer(d[1]) && d[1].length === 33
    })
    assert.ok(msOut, 'a bare-multisig data output must be present')
    const decompiled = bitcoin.script.decompile(msOut.script)
    let payload = Buffer.concat([decompiled[1].subarray(1), decompiled[2].subarray(1)])
    for (let i = payload.length - 1; i >= 0; i--) {
      if (payload[i] !== 0) { payload = payload.subarray(0, i + 1); break }
    }
    assert.strictEqual(deobfuscate(payload, ins0Txid(result)).subarray(0, 4).toString('utf8'), MAGIC,
      'the MULTISIGN action must decode with ins[0].txid')
  })
})
