// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression: a rawData-only create_tx (data absent/empty, rawData present) clears
// every encoder gate and broadcasts, but compiles to an OP_0-led payload that the
// decoder's arbiter gate blanks without reading the trailing rawData push. The
// transaction confirms, the fee is paid, and the payload is never indexed as an
// ACTION, with the only signal on another service's operator console.
//
// The encoder does not REFUSE the shape: whether it becomes readable end to end is a
// cross-service flag-day decision that governs the decoder gate and validator.js
// together, and refusing here would settle half of it unilaterally. What the encoder
// owes the fee-payer is a signal before signing, so the built result carries a
// non-fatal RAWDATA_ONLY_NOT_DECODED warning. These tests pin that the shape still
// builds, that the warning is present, and that an ordinary data-carrying build stays
// warning-free.

const assert = require('assert')
const {
  makeEncoder, makeSegwitUtxo, getTestAddress, TXID_A
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')
const openrpc = require('../../docs/openrpc.json')

const NETWORK = 'dogecoin-regtest'

function callerUtxos () {
  return [makeSegwitUtxo(TXID_A, 0, 100000000)]
}

describe('rawData-only create_tx warning @regression', function () {
  this.timeout(10000)

  it('still builds the shape, and warns that it will not be indexed', async function () {
    const encoder = makeEncoder(NETWORK)
    const address = getTestAddress(NETWORK)

    const result = await encoder.createTransaction(
      callerUtxos(), address, null, null, 'some raw payload bytes', 10000, false, null, address,
      null, null, null, true, 0.00001
    )

    assert.ok(result.psbt, 'the shape must still encode; refusing it is a flag-day decision')
    assert.ok(Array.isArray(result.warnings), 'a rawData-only build must carry warnings')
    assert.strictEqual(result.warnings.length, 1)
    assert.strictEqual(result.warnings[0].code, 'RAWDATA_ONLY_NOT_DECODED')
    assert.match(result.warnings[0].message, /will not be indexed as an ACTION/)
  })

  it('does not warn on an ordinary data-carrying build', async function () {
    const encoder = makeEncoder(NETWORK)
    const address = getTestAddress(NETWORK)
    const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)

    const result = await encoder.createTransaction(
      callerUtxos(), address, null, action.data, null, 10000, false, null, address,
      null, null, null, true, 0.00001
    )

    assert.strictEqual(result.warnings, undefined,
      'a decodable payload must not carry a caveat the caller would learn to ignore')
  })

  it('declares the warnings field in the create_tx result contract', function () {
    const createTx = openrpc.methods.find(m => m.name === 'create_tx')
    const warnings = createTx.result.schema.properties.warnings
    assert.ok(warnings, 'docs/openrpc.json must document the additive result field')
    assert.match(warnings.description, /RAWDATA_ONLY_NOT_DECODED/)
  })
})
