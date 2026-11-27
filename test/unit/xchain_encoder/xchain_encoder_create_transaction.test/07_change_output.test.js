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
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

async function addsChangeOutput () {
  const encoder = makeEncoder()
  // Isolate the change math from the network dust floor so the 10000 custom fee
  // flows into change verbatim (the dust floor has its own suite).
  encoder.dustAmount = 546
  const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

  const result = await encoder.createTransaction(
    [utxo], TEST_ADDRESS, null,
    'test', null, 10000, false, null, TEST_ADDRESS,
    null, null, null, true, 0.00001
  )

  const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
  assert.ok(changeOutput, 'change output should exist')
  assert.strictEqual(Number(changeOutput.value), 100000000 - 10000)
}

async function rejectsMissingChangeAddress () {
  const encoder = makeEncoder()
  const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

  await assert.rejects(
    () => encoder.createTransaction(
      [utxo], TEST_ADDRESS, null,
      'test', null, 10000, false, null, null, // no change address
      null, null, null, true, 0.00001
    ),
    /change address/i
  )
}

async function rejectsChangeAboveFeeBackstop () {
  const encoder = makeEncoder()
  encoder.dustAmount = 546
  encoder.outputFloor = 1000000
  const utxo = makeSegwitUtxo(TXID_A, 0, 1000000)
  const customOutputs = [{ address: TEST_ADDRESS, value: '10000' }]

  await assert.rejects(
    () => encoder.createTransaction(
      [utxo], TEST_ADDRESS, customOutputs,
      'test', null, 546, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    ),
    (err) => err.xchainCode === 'CHANGE_BELOW_OUTPUT_FLOOR' &&
      err.details.changeSatoshis === 989454 && err.details.actualFee === 990000
  )
}

async function rejectsChangeAboveFeeRateCap () {
  const encoder = makeEncoder()
  encoder.dustAmount = 546
  encoder.outputFloor = 50000
  encoder.maxFeePerBytes = 2e-7
  encoder.connector.getFeePerKilobyte = async () => 0.00003
  const utxo = makeSegwitUtxo(TXID_A, 0, 1000000)
  const customOutputs = [{ address: TEST_ADDRESS, value: '970000' }]

  await assert.rejects(
    () => encoder.createTransaction(
      [utxo], TEST_ADDRESS, customOutputs,
      'test', null, null, false, null, TEST_ADDRESS,
      null, null, null, true, 20000
    ),
    (err) => err.xchainCode === 'CHANGE_BELOW_OUTPUT_FLOOR' &&
      /fee-rate cap/.test(err.message)
  )
}

function defineChangeOutputTests () {
  it('adds change output when there is leftover and change address given', addsChangeOutput)
  it('throws when change address is falsy and change would be burned', rejectsMissingChangeAddress)
  it('refuses a build whose sub-floor change would exceed the actual fee backstop', rejectsChangeAboveFeeBackstop)
  it('refuses feePerKb-priced sub-floor change that exceeds the fee-rate cap', rejectsChangeAboveFeeRateCap)
}

function defineCreateTransactionTests () {
  describe('change output', defineChangeOutputTests)
}

describe('XChainEncoder.createTransaction()', defineCreateTransactionTests)
