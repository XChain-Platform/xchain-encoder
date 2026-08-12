// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression: a createTransaction that throws must release the outpoint
// reservations IT took, and only those.
//
// The reservation map exists to stop two concurrent create_tx calls for one
// address from selecting the same UTXOs and emitting conflicting double-spends.
// Entries lapse after RESERVATION_TTL_MS (5 minutes). Before this fix a throw
// left the failed call's claims in the map for the whole TTL, so the retry the
// error message asks for saw its own dead reservations and came back
// INSUFFICIENT_FUNDS. The release must be ownership-checked: dropping a foreign
// entry would reopen exactly the double-spend window the map closes.

const assert = require('assert')
const {
  makeEncoder, makeSegwitUtxo, getTestAddress, TXID_A, TXID_B
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'
const FIVE_MINUTES = 5 * 60 * 1000

function ins0Txid (result) {
  return Buffer.from(result.psbt.txInputs[0].hash).reverse().toString('hex')
}

// Two equal-value tracker UTXOs. Equal values keep the encoder's sort stable, so
// TXID_A is the earlier-sorted candidate and TXID_B the later one.
function twoUtxoEncoder (value = 100000000) {
  const encoder = makeEncoder(NETWORK)
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [makeSegwitUtxo(TXID_A, 0, value), makeSegwitUtxo(TXID_B, 0, value)]
    })
  }
  return encoder
}

// Run `mutate` once, inside the async data loop, without replacing obfuscate():
// the real implementation still produces the payload.
function lapseReservationDuringDataLoop (encoder, mutate) {
  const realObfuscate = encoder.obfuscate.bind(encoder)
  let fired = false
  encoder.obfuscate = async (...args) => {
    if (!fired) {
      fired = true
      mutate()
    }
    return realObfuscate(...args)
  }
}

function sendTx (encoder, address, amount = '42') {
  const action = actions.makeSend('JDOG', amount, actions.ADDR_BTC)
  return encoder.createTransaction(
    null, address, null, action.data, null, 10000, false, null, address,
    null, null, null, true, 0.00001
  )
}

describe('reservation release on throw @regression', function () {
  this.timeout(10000)

  it('INPUT_SELECTION_RACE: the retry it asks for succeeds inside the TTL', async function () {
    const encoder = twoUtxoEncoder()
    const address = getTestAddress(NETWORK)

    // Both outpoints are claimed by concurrent calls, so nothing can be
    // pre-reserved and the key falls back to TXID_A. TXID_B then frees during the
    // data loop and takes ins[0], which trips the fail-closed guard.
    encoder.outpointReservations.set(TXID_A + ':0', Date.now() + FIVE_MINUTES)
    encoder.outpointReservations.set(TXID_B + ':0', Date.now() + FIVE_MINUTES)
    lapseReservationDuringDataLoop(encoder, () => {
      encoder.outpointReservations.set(TXID_B + ':0', Date.now() - 1)
    })

    await assert.rejects(() => sendTx(encoder, address), err => {
      assert.strictEqual(err.xchainCode, 'INPUT_SELECTION_RACE')
      return true
    })

    // The failed call took TXID_B during selection. If it squats on that claim
    // the immediate retry has no candidate left and reports INSUFFICIENT_FUNDS.
    assert.ok(!encoder.outpointReservations.has(TXID_B + ':0'),
      'the failed call must release the outpoint it reserved')

    const retry = await sendTx(encoder, address)
    assert.strictEqual(ins0Txid(retry), TXID_B,
      'the retry must be able to select the released outpoint')
  })

  it('a foreign reservation survives another call throwing', async function () {
    const encoder = twoUtxoEncoder()
    const address = getTestAddress(NETWORK)

    const foreignExpiry = Date.now() + FIVE_MINUTES
    encoder.outpointReservations.set(TXID_A + ':0', foreignExpiry)
    encoder.outpointReservations.set(TXID_B + ':0', Date.now() + FIVE_MINUTES)
    lapseReservationDuringDataLoop(encoder, () => {
      encoder.outpointReservations.set(TXID_B + ':0', Date.now() - 1)
    })

    await assert.rejects(() => sendTx(encoder, address), err => {
      assert.strictEqual(err.xchainCode, 'INPUT_SELECTION_RACE')
      return true
    })

    assert.strictEqual(encoder.outpointReservations.get(TXID_A + ':0'), foreignExpiry,
      'a reservation held by another in-flight call must not be dropped')
  })

  it('an outpoint re-reserved by another call after ours lapsed is left alone', async function () {
    // Dust-sized UTXOs, so the build fails on the change math after selection.
    const encoder = twoUtxoEncoder(600)
    const address = getTestAddress(NETWORK)

    // This call pre-reserves TXID_A. While the data loop runs, model its claim
    // lapsing and a concurrent call re-taking the same outpoint. The stale record
    // must not let the release on the throw below steal the new claim.
    let foreignExpiry = null
    lapseReservationDuringDataLoop(encoder, () => {
      foreignExpiry = Date.now() + FIVE_MINUTES + 1
      encoder.outpointReservations.set(TXID_A + ':0', foreignExpiry)
      encoder.outpointReservations.set(TXID_B + ':0', foreignExpiry)
    })

    await assert.rejects(() => sendTx(encoder, address), err => {
      assert.strictEqual(err.xchainCode, 'INSUFFICIENT_FUNDS')
      return true
    })

    assert.strictEqual(encoder.outpointReservations.get(TXID_A + ':0'), foreignExpiry,
      'the re-reserved outpoint belongs to the other call now')
    assert.strictEqual(encoder.outpointReservations.get(TXID_B + ':0'), foreignExpiry,
      'the re-reserved outpoint belongs to the other call now')
  })

  it('INSUFFICIENT_FUNDS on an under-funded build also releases its claims', async function () {
    // One dust-sized tracker UTXO: selection takes and reserves it, then the
    // change math rejects the build. A retry with a cheaper request must still
    // see the outpoint as spendable.
    const encoder = twoUtxoEncoder(600)
    const address = getTestAddress(NETWORK)

    await assert.rejects(() => sendTx(encoder, address), err => {
      assert.strictEqual(err.xchainCode, 'INSUFFICIENT_FUNDS')
      return true
    })

    assert.strictEqual(encoder.outpointReservations.size, 0,
      'a failed build must not leave reservations behind')
  })

  it('a successful build keeps its reservations for the TTL', async function () {
    const encoder = twoUtxoEncoder()
    const address = getTestAddress(NETWORK)

    const result = await sendTx(encoder, address)

    assert.strictEqual(ins0Txid(result), TXID_A)
    assert.ok(encoder.outpointReservations.has(TXID_A + ':0'),
      'the double-spend guard depends on a successful selection staying reserved')
  })
})
