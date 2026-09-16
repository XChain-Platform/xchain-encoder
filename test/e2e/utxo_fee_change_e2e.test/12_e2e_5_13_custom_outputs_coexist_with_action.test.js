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

  describe('E2E-5.13: Custom outputs coexist with ACTION', () => {
    it('custom output value deducted from change', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeUtxo(NETWORK, TXID_A, 0, 100000000)
      const action = actions.makeSend()
      const fee = 10000

      const resultNone = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, fee, false, null, address,
        null, null, null, true, 0.00001
      )

      // Same input on purpose: this compares two builds of one spend, so release
      // the first build's reservation rather than double-spend it.
      encoder.clearReservations()
      const resultCustom = await encoder.createTransaction(
        [utxo], address, [{ address, value: '500000' }],
        action.data, null, fee, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeNone = resultNone.psbt.txOutputs.reduce((m, o) => o.value > m ? o.value : m, 0)
      const changeCustom = resultCustom.psbt.txOutputs.reduce((m, o) => o.value > m ? o.value : m, 0)
      assert.strictEqual(changeNone - changeCustom, 500000)
    })
  })
})
