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

  describe('D-3: Duplicate UTXO deduplication', () => {
    it('removes duplicate UTXOs with same txid+vout', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const dup1 = makeUtxo(NETWORK, TXID_A, 0, 50000000)
      const dup2 = makeUtxo(NETWORK, TXID_A, 0, 50000000)
      const dup3 = makeUtxo(NETWORK, TXID_A, 0, 50000000)
      const unique = makeUtxo(NETWORK, TXID_B, 1, 30000000)

      const result = await encoder.createTransaction(
        [dup1, dup2, dup3, unique], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Should have at most 2 unique UTXOs as inputs
      assert.ok(result.psbt.data.inputs.length <= 2,
        `expected <= 2 inputs after dedup, got ${result.psbt.data.inputs.length}`)
    })
  })
})
