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
 * Category D: UTXO & Fee Integration
 *
 * Verifies UTXO deduplication, sorting, filtering, fee estimation, fee caps,
 * dust floors, and change output logic with realistic ACTION payloads.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../src/XChainEncoder')
const {
  TXID_A,
  TXID_B,
  TXID_C,
  PUBKEY_BUF,
  makeUtxo,
  makeLegacyUtxo,
  makeMempoolUtxo,
  makeTrackerEnvelope,
  makeEncoder,
  getTestAddress,
  buildRawTxHex
} = require('../helpers/utxoFactory')
const actions = require('../helpers/actionFactory')

// These integration cases encode BITCOIN fee semantics (explicit fees honored
// verbatim, sub-estimate fees, 546 dust). The network was mislabeled
// 'dogecoin-regtest' (dust 100000), so any fee below 100000 was floored and the
// "verbatim"/cap-comparison assertions failed. Bitcoin-regtest matches the
// semantics these assertions actually test. (DOGE's high-dust floor is covered
// in test/boundary/fee_calculation_boundaries.test.js.)
const NETWORK = 'bitcoin-regtest'

describe('Category D: UTXO & Fee Integration', () => {

  describe('D-7: Fee capped by maxFeePerBytes', () => {
    it('limits fee when maxFeeRateKb is set', async () => {
      // Create encoder WITH fee cap
      const capped = new XChainEncoder(
        NETWORK, '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 1000 // 1000 sat/kB cap
      )
      capped.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => ({ hex: buildRawTxHex(100000000, NETWORK) }),
        isRegtest: async () => true
      }
      capped.utxoTrackerConnector = {
        getUtxosFromAddress: async () => makeTrackerEnvelope([makeUtxo(NETWORK, TXID_A, 0, 100000000)])
      }

      const address = getTestAddress(NETWORK)
      const utxo = makeUtxo(NETWORK, TXID_A, 0, 100000000)
      const action = actions.makeSend()

      // Use a very high feePerKb that exceeds the cap
      const result = await capped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 100000000 // very high: 1e8 sat/kB = 100000 sat/byte
      )

      // Create uncapped encoder for comparison
      const uncapped = makeEncoder(NETWORK)
      const resultUncapped = await uncapped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 100000000
      )

      // Capped encoder should produce lower fee (more change)
      const cappedChange = result.psbt.txOutputs.find(o => o.value > 0)
      const uncappedChange = resultUncapped.psbt.txOutputs.find(o => o.value > 0)
      assert.ok(cappedChange.value > uncappedChange.value,
        'capped fee should leave more change than uncapped')
    })
  })
})
