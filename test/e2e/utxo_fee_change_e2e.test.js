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
const XChainEncoder = require('../../src/XChainEncoder')
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
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

// BTC semantics: the change/fee assertions assume the supplied fee (10000) is
// honored. DOGE floors sub-100000 fees, which would skew these. The dust-floor
// tests below read encoder.dustAmount dynamically, so they hold on bitcoin too.
const NETWORK = 'bitcoin-regtest'

describe('E2E-5: UTXO, Fee, and Change Integration', () => {

  describe('E2E-5.1: Single UTXO covers all', () => {
    it('1 input, OP_RETURN + change; change = input - fee', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeUtxo(NETWORK, TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
      assert.strictEqual(result.psbt.txOutputs.length, 2)

      const opReturn = result.psbt.txOutputs.filter(o => o.value === 0)
      const change = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(opReturn.length, 1)
      assert.strictEqual(change.length, 1)
      assert.strictEqual(change[0].value, 100000000 - 10000)
    })
  })
})
