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
} = require('../integration/helpers/deobfuscate')
const {
  TXID_A,
  makeUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

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
  describe('E2E-1.1: Simple SEND v0', () => {
    it('SEND|0|JDOG|100|<addr> encodes to valid OP_RETURN PSBT with exact payload', async () => {
      const action = actions.makeSend('JDOG', '100', actions.ADDR_BTC)
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  describe('E2E-1.2: SEND with memo', () => {
    it('memo field survives full pipeline', async () => {
      const action = actions.makeSend('JDOG', '100', actions.ADDR_BTC, 'Payment for services')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('Payment for services'))
    })
  })

  describe('E2E-1.3: SEND v1 multi-output', () => {
    it('multiple AMOUNT|DEST pairs preserved', async () => {
      const action = actions.makeMultiSendV1('BRR', [
        { amount: '5', dest: 'mfWxJ45' },
        { amount: '1', dest: 'n1BNcx3' }
      ])
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.startsWith('SEND|1|'))
    })
  })

  describe('E2E-1.4: SEND v2 multi-token', () => {
    it('multi-token TICK|AMT|DEST triplets preserved', async () => {
      const action = actions.makeMultiSendV2([
        { tick: 'AA', amount: '5', dest: 'mfWxJ45' },
        { tick: 'BB', amount: '1', dest: 'n1BNcx3' }
      ])
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.startsWith('SEND|2|'))
      assert.ok(dataString.includes('AA'))
      assert.ok(dataString.includes('BB'))
    })
  })

  describe('E2E-1.5: SEND v3 multi-token with per-transfer memo', () => {
    it('per-transfer memos preserved', async () => {
      const action = actions.makeMultiSendV3([
        { tick: 'AA', amount: '5', dest: 'mfWxJ45', memo: 'hi' },
        { tick: 'BB', amount: '1', dest: 'n1BNcx3', memo: 'bye' }
      ])
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.startsWith('SEND|3|'))
      assert.ok(dataString.includes('hi'))
      assert.ok(dataString.includes('bye'))
    })
  })
})
describe('E2E-1: Full ACTION-to-PSBT Pipeline', () => {
  describe('E2E-1.6: Full ISSUE with all 25+ fields (P2SH)', () => {
    it('produces valid P2SH PSBT with correctly structured output', async () => {
      const action = actions.makeIssueFull('TESTTOKEN')
      const { result } = await encodeFull(action)

      assert.strictEqual(result.encoding, 'P2SH')

      // P2SH tx1: find the P2SH output (OP_HASH160 <20-byte> OP_EQUAL)
      const outputs = result.psbt.txOutputs
      const p2shOutputs = outputs.filter(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160 &&
               Buffer.isBuffer(d[1]) && d[1].length === 20 &&
               d[2] === bitcoin.opcodes.OP_EQUAL
      })
      assert.ok(p2shOutputs.length >= 1, 'should have P2SH output')
      for (const o of p2shOutputs) {
        assert.ok(o.value >= 546, 'P2SH output should be >= dust')
      }

      // Should have change output
      const changeOutput = outputs.reduce((max, o) => o.value > max.value ? o : max, { value: 0 })
      assert.ok(changeOutput.value > 0, 'should have change output')
    })
  })

  describe('E2E-1.7: Minimal ISSUE', () => {
    it('ISSUE|0|X auto-selects OP_RETURN', async () => {
      const action = actions.makeIssueMinimal('X')
      const { dataString, result } = await encodeFull(action)
      assert.strictEqual(result.encoding, 'OP_RETURN')
      assert.strictEqual(dataString, 'ISSUE|0|X')
    })
  })

  describe('E2E-1.8: ISSUE v1 description edit', () => {
    it('version 1 format with description preserved', async () => {
      const action = actions.makeIssueEditDescription('TEST', 'New desc')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.startsWith('ISSUE|1|'))
      assert.ok(dataString.includes('New desc'))
    })
  })

  describe('E2E-1.9: MINT', () => {
    it('tick and amount preserved', async () => {
      const action = actions.makeMint('JDOG', '999')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('999'))
    })
  })
})
describe('E2E-1: Full ACTION-to-PSBT Pipeline', () => {
  describe('E2E-1.10: DESTROY', () => {
    it('burn amount preserved', async () => {
      const action = actions.makeDestroy('JDOG', '50')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  describe('E2E-1.11: CALLBACK', () => {
    it('minimal callback payload preserved', async () => {
      const action = actions.makeCallback('JDOG')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  describe('E2E-1.12: SLEEP', () => {
    it('resume block number preserved', async () => {
      const action = actions.makeSleep('JDOG', '900000')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('900000'))
    })
  })

  describe('E2E-1.13: SWEEP', () => {
    it('destination address preserved', async () => {
      const action = actions.makeSweep(actions.ADDR_BTC)
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })
})
