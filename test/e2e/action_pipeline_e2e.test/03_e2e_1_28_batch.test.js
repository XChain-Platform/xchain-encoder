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
 * E2E-1: Full ACTION-to-PSBT Pipeline
 *
 * Validates every supported ACTION type through the complete encoding pipeline:
 * ACTION config → script compilation → prepareData() → obfuscation → PSBT.
 * Each test verifies the returned PSBT is structurally valid and, for OP_RETURN
 * payloads, that the deobfuscated data matches the original ACTION string.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  extractOpReturnPayload,
  decompilePayload,
  MAGIC_WORD
} = require('../../integration/helpers/deobfuscate')
const {
  TXID_A,
  makeUtxo,
  makeEncoder,
  getTestAddress
} = require('../../integration/helpers/utxoFactory')
const actions = require('../../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

function stdUtxo () {
  return makeUtxo(NETWORK, TXID_A, 0, 100000000)
}

/**
 * Encode an ACTION and, if it fits OP_RETURN, verify full round-trip fidelity.
 * For P2SH payloads, verify structural validity only.
 */
async function encodeFull (actionObj, opts = {}) {
  const encoder = makeEncoder(opts.network || NETWORK)
  const address = getTestAddress(opts.network || NETWORK)
  const utxo = stdUtxo()

  const result = await encoder.createTransaction(
    [utxo], address, null,
    actionObj.data, actionObj.rawData, 10000, false, opts.encoding || null, address,
    null, null, null, true, 0.00001
  )

  assert.ok(result.psbt instanceof bitcoin.Psbt, 'result.psbt should be a Psbt instance')
  assert.ok(['OP_RETURN', 'P2SH', 'P2WSH', 'MULTISIGN'].includes(result.encoding))

  if (result.encoding === 'OP_RETURN') {
    const payload = extractOpReturnPayload(result, TXID_A)
    assert.strictEqual(payload.magic, MAGIC_WORD, 'magic word should be XCHN')
    const decompiled = decompilePayload(payload.dataBuffer)
    return { result, payload, decompiled, dataString: decompiled[0].toString('utf8') }
  }

  return { result, payload: null, decompiled: null, dataString: null }
}
describe('E2E-1: Full ACTION-to-PSBT Pipeline', () => {
  describe('E2E-1.28: BATCH', () => {
    it('semicolon-separated actions preserved', async () => {
      const batch = actions.makeBatch([
        actions.makeSend('A', '1', actions.ADDR_BTC),
        actions.makeDestroy('B', '2')
      ])
      const { dataString } = await encodeFull(batch)
      assert.strictEqual(dataString, batch.data)
      assert.ok(dataString.includes(';'))
    })
  })

  describe('E2E-1.29: Large BATCH forces P2SH', () => {
    it('5+ actions in batch exceeds OP_RETURN and auto-selects P2SH', async () => {
      const batch = actions.makeBatch([
        actions.makeSend('A', '1', actions.ADDR_BTC),
        actions.makeSend('B', '2', actions.ADDR_BTC),
        actions.makeSend('C', '3', actions.ADDR_BTC),
        actions.makeSend('D', '4', actions.ADDR_BTC),
        actions.makeSend('E', '5', actions.ADDR_BTC)
      ])
      const { result } = await encodeFull(batch)
      assert.strictEqual(result.encoding, 'P2SH')
    })
  })

  describe('E2E-1.30: TICK by ID reference', () => {
    it('caret prefix preserved', async () => {
      const action = actions.makeSendByTickId('1234', '100', actions.ADDR_BTC)
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('^1234'))
    })
  })
})
