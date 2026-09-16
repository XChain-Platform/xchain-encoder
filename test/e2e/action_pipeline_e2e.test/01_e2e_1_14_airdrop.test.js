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
  describe('E2E-1.14: AIRDROP', () => {
    it('list index reference preserved', async () => {
      const action = actions.makeAirdrop('JDOG', '100', '10')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  describe('E2E-1.15: DIVIDEND', () => {
    it('two-tick relationship preserved', async () => {
      const action = actions.makeDividend('JDOG', 'BRRR', '1000')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('JDOG'))
      assert.ok(dataString.includes('BRRR'))
    })
  })

  describe('E2E-1.16: ORDER BUY', () => {
    it('all DEX fields preserved', async () => {
      const action = actions.makeOrder('BUY', 'JDOG', '100', 'BRRR', '50', '0')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('BUY'))
    })
  })

  describe('E2E-1.17: ORDER SELL', () => {
    it('SELL type preserved', async () => {
      const action = actions.makeOrder('SELL', 'JDOG', '100', 'BRRR', '50', '100')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('SELL'))
    })
  })

  describe('E2E-1.18: COINPAY', () => {
    it('order match index preserved', async () => {
      const action = actions.makeCoinpay('42')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('42'))
    })
  })

  describe('E2E-1.19: DISPENSER', () => {
    it('all dispenser params preserved', async () => {
      const action = actions.makeDispenser('JDOG', '100', '10', '1', actions.ADDR_BTC)
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })
})
describe('E2E-1: Full ACTION-to-PSBT Pipeline', () => {
  describe('E2E-1.20: SWAP', () => {
    it('cross-chain identifiers preserved', async () => {
      const action = actions.makeSwap('JDOG', '100', 'LTC', 'LDOG', '200')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('LTC'))
      assert.ok(dataString.includes('LDOG'))
    })
  })
})
