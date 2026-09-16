/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E-5: UTXO, Fee, and Change Integration
 *
 * Validates PSBT input selection, fee calculation, and change outputs
 * for realistic encoding scenarios.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../src/XChainEncoder')
const {
  TXID_A,
  TXID_B,
  TXID_C,
  makeUtxo,
  makeLegacyUtxo,
  makeMempoolUtxo,
  makeEncoder,
  getTestAddress,
  buildRawTxHex
} = require('../../integration/helpers/utxoFactory')
const actions = require('../../integration/helpers/actionFactory')

// BTC semantics: the change/fee assertions assume the supplied fee (10000) is
// honored. DOGE floors sub-100000 fees, which would skew these. The dust-floor
// tests below read encoder.dustAmount dynamically, so they hold on bitcoin too.
const NETWORK = 'bitcoin-regtest'

describe('E2E-5: UTXO, Fee, and Change Integration', () => {

  describe('E2E-5.8: Fee cap enforcement', () => {
    it('caps fee when maxFeeRateKb is set', async () => {
      const capped = new XChainEncoder(
        NETWORK, '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 1000
      )
      capped.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => buildRawTxHex(100000000, NETWORK),
        isRegtest: async () => true
      }
      capped.utxoTrackerConnector = {
        getUtxosFromAddress: async () => ({ utxos: [] })
      }

      const address = getTestAddress(NETWORK)
      const utxo = makeUtxo(NETWORK, TXID_A, 0, 100000000)
      const action = actions.makeSend()

      // feePerKb is in base units (sat/litoshi/koinu) per kB. 1_000_000
      // sat/kB is far above the capped encoder's 1000 sat/kB absolute cap,
      // so the capped run must clamp its rate while the uncapped run does
      // not, leaving the capped transaction with a smaller fee (more change).
      const HIGH_FEE_PER_KB = 1000000

      const resultCapped = await capped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, HIGH_FEE_PER_KB
      )

      const uncapped = makeEncoder(NETWORK)
      const resultUncapped = await uncapped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, HIGH_FEE_PER_KB
      )

      const cappedChange = resultCapped.psbt.txOutputs.find(o => o.value > 0)
      const uncappedChange = resultUncapped.psbt.txOutputs.find(o => o.value > 0)
      assert.ok(cappedChange.value > uncappedChange.value,
        'capped fee should leave more change')
    })
  })
})
