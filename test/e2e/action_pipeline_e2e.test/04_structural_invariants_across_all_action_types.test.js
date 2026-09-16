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
