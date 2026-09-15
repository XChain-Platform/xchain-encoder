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

  describe('D-4: Unconfirmed filtering with unconfirmed=false', () => {
    it('excludes mempool UTXOs when unconfirmed=false', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const confirmed = makeUtxo(NETWORK, TXID_A, 0, 100000000)
      confirmed.confirmations = 6
      const mempool = makeMempoolUtxo(TXID_B, 0, 50000000)

      const result = await encoder.createTransaction(
        [mempool, confirmed], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, false, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })

    it('includes mempool UTXOs when unconfirmed=true', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const mempool = makeMempoolUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [mempool], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })
})
