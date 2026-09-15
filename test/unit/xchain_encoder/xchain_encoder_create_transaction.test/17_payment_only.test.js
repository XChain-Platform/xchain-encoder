// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
  assert,
  bitcoin,
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

// `data` has always been optional on the wire ("payment-only tx"), but the
// emission path still wrote a nulldata output for it: the empty payload
// compiled to an OP_0 push, took the 4-byte magic word, and shipped as a
// magic-word-only OP_RETURN carrying no action. Every plain native-coin send
// the wallet made paid for that output and announced itself as an XChain
// transaction while containing nothing to decode.

describe('XChainEncoder.createTransaction() payment-only', () => {
  const opReturnOutputs = (psbt) =>
    psbt.txOutputs.filter((o) => bitcoin.script.toASM(o.script).startsWith('OP_RETURN'))

  it('emits NO OP_RETURN output when there is no action payload', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS,
      [{ address: TEST_ADDRESS, value: '1000000' }],
      null, null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )

    assert.strictEqual(opReturnOutputs(result.psbt).length, 0,
      'a payment with no action must not carry a nulldata output')
    // The payment itself still has to be there, or "no OP_RETURN" would pass
    // on a transaction that also lost the thing it was meant to send.
    assert.ok(result.psbt.txOutputs.some((o) => Number(o.value) === 1000000),
      'the customOutput payment is missing')
  })

  it('treats an empty-string action the same as an absent one', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS,
      [{ address: TEST_ADDRESS, value: '1000000' }],
      '', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.strictEqual(opReturnOutputs(result.psbt).length, 0)
  })

  it('still emits the OP_RETURN when an action IS present', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS,
      [{ address: TEST_ADDRESS, value: '1000000' }],
      'SEND|0|TOKEN|1|' + TEST_ADDRESS, null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.strictEqual(opReturnOutputs(result.psbt).length, 1,
      'dropping the nulldata output for real actions would break every action')
  })

  it('still emits a nulldata output for a rawData-only payload', async () => {
    // rawData with no `data` is a deliberately-supported shape and IS content;
    // "no action string" must not be read as "nothing to write".
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
      null, 'rawpayload', 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.strictEqual(opReturnOutputs(result.psbt).length, 1)
  })
})
