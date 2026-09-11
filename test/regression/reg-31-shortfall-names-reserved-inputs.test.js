/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * REG-31: a shortfall caused by RESERVED inputs names them.
 *
 * Measured on TDOGE 2026-09-08 from an address holding 1072 + 950 DOGE and one
 * 0.001 DOGE dust output: two successful builds (each reserving one large
 * output for RESERVATION_TTL_MS) and the third build selected only the dust
 * output and threw "insufficient funds: selected inputs total 100000 but
 * 2910000 is required", with nothing in the message or details saying that the
 * other two candidates were on hold. The wallet rendered it as "You don't have
 * enough funds", to a user holding 2,000 DOGE.
 *
 * The zero-selected branch already said "reserved by a transaction built in
 * the last N minutes"; this pins the same wording and a reservedCandidates
 * count on the partial-selection branch, so one reader handles both.
 *********************************************************************/
const assert = require('assert')
const {
  makeEncoder, makeUtxo, getTestAddress, TXID_A, TXID_B, TXID_C
} = require('../integration/helpers/utxoFactory')

const NETWORK = 'bitcoin-regtest'
const SEND = 'SEND|0|XCHAIN|1|' + getTestAddress(NETWORK)

function build (encoder, utxos) {
  const address = getTestAddress(NETWORK)
  return encoder.createTransaction(
    utxos, address, null, SEND, null, 10000, false, null, address,
    null, null, null, true, 0.00001
  )
}

describe('REG-31: a shortfall caused by reserved inputs names them @regression', function () {
  this.timeout(10000)

  // Two spendable outputs and one dust output, the measured TDOGE shape.
  function view () {
    return [
      makeUtxo(NETWORK, TXID_A, 0, 100000000),
      makeUtxo(NETWORK, TXID_B, 0, 1000),
      makeUtxo(NETWORK, TXID_C, 0, 90000000)
    ]
  }

  it('third build after two un-broadcast builds: dust-only selection, reserved candidates named', async () => {
    const encoder = makeEncoder(NETWORK)
    const first = await build(encoder, view())
    const second = await build(encoder, view())
    assert.strictEqual(first.psbt.txInputs.length, 1)
    assert.strictEqual(second.psbt.txInputs.length, 1)
    assert.strictEqual(encoder.outpointReservations.size, 2, 'the two large outputs are on hold')

    await assert.rejects(
      () => build(encoder, view()),
      (err) => {
        assert.strictEqual(err.operational, true)
        assert.strictEqual(err.xchainCode, 'INSUFFICIENT_FUNDS')
        // The partial selection is still reported (the dust output was taken)...
        assert.strictEqual(err.details.available, 1000)
        // ...and the hold is now visible in both the details and the message.
        assert.strictEqual(err.details.reservedCandidates, 2)
        assert.match(err.message, /2 candidate input\(s\) are reserved by a transaction built in the last 5 minutes/)
        assert.match(err.message, /broadcast that transaction or wait/)
        return true
      }
    )
  })

  it('a genuinely under-funded address reports zero reserved candidates and no hold wording', async () => {
    const encoder = makeEncoder(NETWORK)
    await assert.rejects(
      () => build(encoder, [makeUtxo(NETWORK, TXID_B, 0, 1000)]),
      (err) => {
        assert.strictEqual(err.xchainCode, 'INSUFFICIENT_FUNDS')
        assert.strictEqual(err.details.reservedCandidates, 0)
        assert.doesNotMatch(err.message, /reserved by a transaction built/)
        return true
      }
    )
  })

  it('the failed third build released its own dust claim, leaving only the two live holds', async () => {
    const encoder = makeEncoder(NETWORK)
    await build(encoder, view())
    await build(encoder, view())
    await assert.rejects(() => build(encoder, view()))
    assert.strictEqual(encoder.outpointReservations.size, 2)
  })
})
