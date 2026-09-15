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
  pubkeyBuf,
  TXID_A,
  TXID_B,
  RAW_TX_HEX,
  makeSegwitUtxo,
  makeEncoder,
  LTC_REGTEST,
  TEST_ADDRESS
} = require('./xchain_encoder_create_transaction.test/fixtures/transaction')

describe('XChainEncoder.createTransaction()', () => {

  // Ledger derives the outpoint it signs from the bytes of the previous
  // transaction it is handed, so a witnessUtxo-only input cannot be signed on
  // a device at all. Opt-in, because it costs a node round trip and the prev
  // tx's own weight in every copy of the PSBT, and only that caller needs it.

  describe('attachPrevTx', () => {
    it('leaves segwit inputs witnessUtxo-only by default', async () => {
      const encoder = makeEncoder()
      const result = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )
      const input = result.psbt.data.inputs[0]
      assert.ok(input.witnessUtxo, 'segwit input should carry a witnessUtxo')
      assert.strictEqual(input.nonWitnessUtxo, undefined,
        'the prev tx must not be attached unless it was asked for')
    })

    it('attaches the full previous transaction when asked', async () => {
      const encoder = makeEncoder()
      const result = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001, null, null, true
      )
      const input = result.psbt.data.inputs[0]
      // BOTH, not either: the witnessUtxo is what a software signer and the
      // fee estimator read, and removing it to make room for the prev tx
      // would break every non-hardware path.
      assert.ok(input.witnessUtxo, 'the witnessUtxo must survive')
      assert.ok(Buffer.isBuffer(input.nonWitnessUtxo), 'the prev tx must be attached')
      assert.strictEqual(input.nonWitnessUtxo.toString('hex'), RAW_TX_HEX)
    })

    it('still attaches nothing when the input is legacy anyway', async () => {
      // A legacy input already carries its prev tx; the flag must not double it
      // up or otherwise change that branch.
      const encoder = makeEncoder()
      const legacyUtxo = {
        txid: TXID_B, vout: 1, value: 100000000, confirmations: 6,
        scriptPubKey: bitcoin.payments.p2pkh({
          pubkey: pubkeyBuf, network: LTC_REGTEST
        }).output.toString('hex')
      }
      const result = await encoder.createTransaction(
        [legacyUtxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001, null, null, true
      )
      const input = result.psbt.data.inputs[0]
      assert.ok(Buffer.isBuffer(input.nonWitnessUtxo))
      assert.strictEqual(input.witnessUtxo, undefined)
    })
  })

})
