// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Concurrent builds over one address must not starve each other.
//
// A payment-only build with segwit inputs and no prev-tx attachment awaits
// nothing between claiming its first input and finishing input selection, so
// two such builds racing for the same two outpoints resolve first come, first
// served: one takes both and succeeds, the other finds both reserved. A build
// that suspended between steps or after each selected input would let the
// second build claim the other outpoint during the first build's pause, leave
// each holding half the funds, and fail BOTH with insufficient funds. Nothing
// here is stubbed except the node connector; the real reservation map and
// selection loop run.

const assert = require('assert')
const {
  TXID_A, TXID_B, makeSegwitUtxo, makeEncoder, TEST_ADDRESS
} = require('./fixtures/transaction')

// Each build pays more than one outpoint holds, so it needs both of them.
function paymentNeedingBothInputs (encoder) {
  const utxos = [makeSegwitUtxo(TXID_A, 0, 60000), makeSegwitUtxo(TXID_B, 0, 60000)]
  return encoder.createTransaction(
    utxos, TEST_ADDRESS, [{ address: TEST_ADDRESS, value: '90000' }],
    null, null, 2000, false, null, TEST_ADDRESS,
    null, null, null, true, 0.00001
  )
}

describe('XChainEncoder concurrent input selection', function () {
  it('two builds racing for the same outpoints: one succeeds with both, one is refused', async function () {
    const encoder = makeEncoder()
    const settled = await Promise.allSettled([
      paymentNeedingBothInputs(encoder),
      paymentNeedingBothInputs(encoder)
    ])

    const won = settled.filter(s => s.status === 'fulfilled')
    const lost = settled.filter(s => s.status === 'rejected')
    assert.strictEqual(won.length, 1, 'exactly one build must succeed; ' +
      'two failures means each build claimed one outpoint while the other paused')
    assert.strictEqual(won[0].value.psbt.txInputs.length, 2)
    assert.strictEqual(lost.length, 1)
    assert.strictEqual(lost[0].reason.xchainCode, 'INSUFFICIENT_FUNDS')
    assert.strictEqual(lost[0].reason.details && lost[0].reason.details.reservedCandidates, 2,
      'the refused build must see both outpoints held by the winner')
  })
})
