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
  describe('E2E-1.21: BROADCAST', () => {
    it('message text preserved', async () => {
      const action = actions.makeBroadcast('Hello XChain World')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  describe('E2E-1.22: MESSAGE', () => {
    it('address + text preserved', async () => {
      const action = actions.makeMessage(actions.ADDR_BTC, 'Hello')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  describe('E2E-1.23: FILE small (P2SH)', () => {
    it('file metadata + content encoded as P2SH', async () => {
      const action = actions.makeFile('test.json', 'application/json')
      const { result } = await encodeFull(action)
      assert.strictEqual(result.encoding, 'P2SH')

      // Verify P2SH output exists
      const p2shOutput = result.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160
      })
      assert.ok(p2shOutput, 'should have P2SH output')
    })
  })

  describe('E2E-1.24: FILE large (P2WSH)', () => {
    it('large file encoded as P2WSH when forced', async () => {
      const action = actions.makeFileLarge()
      const { result } = await encodeFull(action, { encoding: 'P2WSH', network: 'bitcoin-regtest' })
      assert.strictEqual(result.encoding, 'P2WSH')

      // Verify P2WSH output: OP_0 <32-byte-hash>
      const p2wshOutput = result.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_0 &&
               Buffer.isBuffer(d[1]) && d[1].length === 32
      })
      assert.ok(p2wshOutput, 'should have P2WSH output')
    })
  })

  describe('E2E-1.25: ADDRESS', () => {
    it('require-memo flag preserved', async () => {
      const action = actions.makeAddress('1')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })
})
describe('E2E-1: Full ACTION-to-PSBT Pipeline', () => {
  describe('E2E-1.26: LINK', () => {
    it('action indices preserved', async () => {
      const action = actions.makeLink('42', '99')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('42'))
      assert.ok(dataString.includes('99'))
    })
  })

  describe('E2E-1.27: LIST', () => {
    it('comma-separated items encoded successfully', async () => {
      // Short addresses to fit OP_RETURN
      const action = actions.makeList(['mfWxJ45', 'n1BNcx3'])
      const { dataString, result } = await encodeFull(action)
      assert.strictEqual(result.encoding, 'OP_RETURN')
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes(','))
    })

    it('full addresses auto-select P2SH', async () => {
      const action = actions.makeList([actions.ADDR_BTC, actions.ADDR_BTC_2])
      const { result } = await encodeFull(action)
      assert.strictEqual(result.encoding, 'P2SH')
    })
  })
})
