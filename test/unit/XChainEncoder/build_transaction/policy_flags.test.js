// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const {
  assert, TXID_A, makeSegwitUtxo, makeEncoder, TEST_ADDRESS
} = require('../../xchain_encoder/xchain_encoder_create_transaction.test/fixtures/transaction')
const { ParamTypeError } = require('../../../../src/build/errors')

function createWith (encoder, fields = {}) {
  return encoder.createTransaction(
    [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
    'test', null, 10000, fields.replacebyfee, null, TEST_ADDRESS,
    null, null, null, fields.unconfirmed, 0.00001, null, null,
    fields.attachPrevTx, fields.compress, fields.options
  )
}

describe('XChainEncoder.createTransaction() library boolean validation', () => {
  const cases = [
    ['replacebyfee', { replacebyfee: 'false' }],
    ['unconfirmed', { unconfirmed: 'false' }],
    ['attachPrevTx', { attachPrevTx: 'false' }],
    ['compress', { compress: 'false' }],
    ['options.exactInputs', { options: { exactInputs: 'false' } }],
    ['options.signerSupportsTapscript', { options: { signerSupportsTapscript: 'false' } }],
    ['options.twoStepEnvelope', { options: { twoStepEnvelope: 'false' } }]
  ]

  for (const [label, fields] of cases) {
    it(`rejects a string value for ${label} before building`, async () => {
      await assert.rejects(createWith(makeEncoder(), fields), (err) => {
        assert.ok(err instanceof ParamTypeError)
        assert.match(err.message, new RegExp(label.replace('.', '\\.')))
        return true
      })
    })
  }

  const containerCases = [
    ['an array', () => Object.assign([], { exactInputs: 'false' })],
    ['a function', () => Object.assign(function opts () {}, { exactInputs: 'false' })],
    ['an inherited property', () => Object.create({ exactInputs: 'false' })]
  ]

  for (const [shape, makeOptions] of containerCases) {
    it(`rejects options.exactInputs carried on ${shape}`, async () => {
      await assert.rejects(createWith(makeEncoder(), { options: makeOptions() }), (err) => {
        assert.ok(err instanceof ParamTypeError)
        assert.match(err.message, /options\.exactInputs/)
        return true
      })
    })
  }

  it('accepts real booleans and null or omitted optional values', async () => {
    const falseResult = await createWith(makeEncoder(), {
      replacebyfee: false, unconfirmed: true, attachPrevTx: false, compress: null,
      options: { exactInputs: false, signerSupportsTapscript: false, twoStepEnvelope: false }
    })
    const trueResult = await createWith(makeEncoder(), { replacebyfee: true })
    assert.strictEqual(falseResult.psbt.txInputs[0].sequence, 0xffffffff)
    assert.strictEqual(trueResult.psbt.txInputs[0].sequence, 0xfffffffd)
  })

  it('leaves no reservation after rejecting a flag', async () => {
    const encoder = makeEncoder()
    await assert.rejects(createWith(encoder, { options: { exactInputs: 'false' } }), ParamTypeError)
    const result = await createWith(encoder, { options: { exactInputs: false } })
    assert.ok(result.psbt)
  })
})
