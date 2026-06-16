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
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

function stdUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
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

  // ── E2E-1.1: Simple token send ────────────────────────────────

  describe('E2E-1.1: Simple SEND v0', () => {
    it('SEND|0|JDOG|100|<addr> encodes to valid OP_RETURN PSBT with exact payload', async () => {
      const action = actions.makeSend('JDOG', '100', actions.ADDR_BTC)
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.2: Send with memo ───────────────────────────────────

  describe('E2E-1.2: SEND with memo', () => {
    it('memo field survives full pipeline', async () => {
      const action = actions.makeSend('JDOG', '100', actions.ADDR_BTC, 'Payment for services')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('Payment for services'))
    })
  })

  // ── E2E-1.3: Multi-output send v1 ────────────────────────────

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

  // ── E2E-1.4: Multi-token send v2 ─────────────────────────────

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

  // ── E2E-1.5: Multi-token+memo send v3 ────────────────────────

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

  // ── E2E-1.6: Full ISSUE (P2SH) ───────────────────────────────

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

  // ── E2E-1.7: Minimal ISSUE (OP_RETURN) ───────────────────────

  describe('E2E-1.7: Minimal ISSUE', () => {
    it('ISSUE|0|X auto-selects OP_RETURN', async () => {
      const action = actions.makeIssueMinimal('X')
      const { dataString, result } = await encodeFull(action)
      assert.strictEqual(result.encoding, 'OP_RETURN')
      assert.strictEqual(dataString, 'ISSUE|0|X')
    })
  })

  // ── E2E-1.8: Description edit (ISSUE v1) ─────────────────────

  describe('E2E-1.8: ISSUE v1 description edit', () => {
    it('version 1 format with description preserved', async () => {
      const action = actions.makeIssueEditDescription('TEST', 'New desc')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.startsWith('ISSUE|1|'))
      assert.ok(dataString.includes('New desc'))
    })
  })

  // ── E2E-1.9: MINT ────────────────────────────────────────────

  describe('E2E-1.9: MINT', () => {
    it('tick and amount preserved', async () => {
      const action = actions.makeMint('JDOG', '999')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('999'))
    })
  })

  // ── E2E-1.10: DESTROY ────────────────────────────────────────

  describe('E2E-1.10: DESTROY', () => {
    it('burn amount preserved', async () => {
      const action = actions.makeDestroy('JDOG', '50')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.11: CALLBACK ───────────────────────────────────────

  describe('E2E-1.11: CALLBACK', () => {
    it('minimal callback payload preserved', async () => {
      const action = actions.makeCallback('JDOG')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.12: SLEEP ──────────────────────────────────────────

  describe('E2E-1.12: SLEEP', () => {
    it('resume block number preserved', async () => {
      const action = actions.makeSleep('JDOG', '900000')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('900000'))
    })
  })

  // ── E2E-1.13: SWEEP ──────────────────────────────────────────

  describe('E2E-1.13: SWEEP', () => {
    it('destination address preserved', async () => {
      const action = actions.makeSweep(actions.ADDR_BTC)
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.14: AIRDROP ────────────────────────────────────────

  describe('E2E-1.14: AIRDROP', () => {
    it('list index reference preserved', async () => {
      const action = actions.makeAirdrop('JDOG', '100', '10')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.15: DIVIDEND ───────────────────────────────────────

  describe('E2E-1.15: DIVIDEND', () => {
    it('two-tick relationship preserved', async () => {
      const action = actions.makeDividend('JDOG', 'BRRR', '1000')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('JDOG'))
      assert.ok(dataString.includes('BRRR'))
    })
  })

  // ── E2E-1.16: ORDER (BUY) ────────────────────────────────────

  describe('E2E-1.16: ORDER BUY', () => {
    it('all DEX fields preserved', async () => {
      const action = actions.makeOrder('BUY', 'JDOG', '100', 'BRRR', '50', '0')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('BUY'))
    })
  })

  // ── E2E-1.17: ORDER (SELL) ───────────────────────────────────

  describe('E2E-1.17: ORDER SELL', () => {
    it('SELL type preserved', async () => {
      const action = actions.makeOrder('SELL', 'JDOG', '100', 'BRRR', '50', '100')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('SELL'))
    })
  })

  // ── E2E-1.18: COINPAY ────────────────────────────────────────

  describe('E2E-1.18: COINPAY', () => {
    it('order match index preserved', async () => {
      const action = actions.makeCoinpay('42')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('42'))
    })
  })

  // ── E2E-1.19: DISPENSER ──────────────────────────────────────

  describe('E2E-1.19: DISPENSER', () => {
    it('all dispenser params preserved', async () => {
      const action = actions.makeDispenser('JDOG', '100', '10', '1', actions.ADDR_BTC)
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.20: SWAP ───────────────────────────────────────────

  describe('E2E-1.20: SWAP', () => {
    it('cross-chain identifiers preserved', async () => {
      const action = actions.makeSwap('JDOG', '100', 'LTC', 'LDOG', '200')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('LTC'))
      assert.ok(dataString.includes('LDOG'))
    })
  })

  // ── E2E-1.21: BROADCAST ──────────────────────────────────────

  describe('E2E-1.21: BROADCAST', () => {
    it('message text preserved', async () => {
      const action = actions.makeBroadcast('Hello XChain World')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.22: MESSAGE ────────────────────────────────────────

  describe('E2E-1.22: MESSAGE', () => {
    it('address + text preserved', async () => {
      const action = actions.makeMessage(actions.ADDR_BTC, 'Hello')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.23: FILE (small, P2SH) ─────────────────────────────

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

  // ── E2E-1.24: FILE (large, P2WSH) ────────────────────────────

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

  // ── E2E-1.25: ADDRESS ────────────────────────────────────────

  describe('E2E-1.25: ADDRESS', () => {
    it('require-memo flag preserved', async () => {
      const action = actions.makeAddress('1')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── E2E-1.26: LINK ───────────────────────────────────────────

  describe('E2E-1.26: LINK', () => {
    it('action indices preserved', async () => {
      const action = actions.makeLink('42', '99')
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('42'))
      assert.ok(dataString.includes('99'))
    })
  })

  // ── E2E-1.27: LIST ───────────────────────────────────────────

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

  // ── E2E-1.28: BATCH (multi-action) ───────────────────────────

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

  // ── E2E-1.29: Large BATCH (P2SH) ─────────────────────────────

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

  // ── E2E-1.30: TICK by ID (caret prefix) ──────────────────────

  describe('E2E-1.30: TICK by ID reference', () => {
    it('caret prefix preserved', async () => {
      const action = actions.makeSendByTickId('1234', '100', actions.ADDR_BTC)
      const { dataString } = await encodeFull(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('^1234'))
    })
  })

  // ── Structural invariants across all types ────────────────────

  describe('Structural invariants across all ACTION types', () => {
    const allActions = [
      { name: 'SEND v0', factory: () => actions.makeSend() },
      { name: 'SEND v1', factory: () => actions.makeMultiSendV1() },
      { name: 'SEND v2', factory: () => actions.makeMultiSendV2() },
      { name: 'SEND v3', factory: () => actions.makeMultiSendV3() },
      { name: 'ISSUE minimal', factory: () => actions.makeIssueMinimal() },
      { name: 'ISSUE full', factory: () => actions.makeIssueFull('TK') },
      { name: 'ISSUE v1', factory: () => actions.makeIssueEditDescription() },
      { name: 'MINT', factory: () => actions.makeMint() },
      { name: 'DESTROY', factory: () => actions.makeDestroy() },
      { name: 'CALLBACK', factory: () => actions.makeCallback() },
      { name: 'SLEEP', factory: () => actions.makeSleep() },
      { name: 'SWEEP', factory: () => actions.makeSweep() },
      { name: 'AIRDROP', factory: () => actions.makeAirdrop() },
      { name: 'DIVIDEND', factory: () => actions.makeDividend() },
      { name: 'ORDER', factory: () => actions.makeOrder() },
      { name: 'COINPAY', factory: () => actions.makeCoinpay() },
      { name: 'DISPENSER', factory: () => actions.makeDispenser() },
      { name: 'SWAP', factory: () => actions.makeSwap() },
      { name: 'BROADCAST', factory: () => actions.makeBroadcast() },
      { name: 'MESSAGE', factory: () => actions.makeMessage() },
      { name: 'FILE', factory: () => actions.makeFile() },
      { name: 'ADDRESS', factory: () => actions.makeAddress() },
      { name: 'LINK', factory: () => actions.makeLink() },
      { name: 'LIST', factory: () => actions.makeList() },
      { name: 'BATCH', factory: () => actions.makeBatch([actions.makeSend(), actions.makeMint()]) },
      { name: 'TICK by ID', factory: () => actions.makeSendByTickId() }
    ]

    for (const { name, factory } of allActions) {
      it(`${name}: produces valid Psbt with >= 1 input and >= 2 outputs`, async () => {
        const action = factory()
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const utxo = stdUtxo()

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, action.rawData, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.ok(result.psbt instanceof bitcoin.Psbt)
        assert.ok(result.psbt.data.inputs.length >= 1, `${name}: should have >= 1 input`)
        assert.ok(result.psbt.txOutputs.length >= 2, `${name}: should have >= 2 outputs`)
      })
    }
  })
})
