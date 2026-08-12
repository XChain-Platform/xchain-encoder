// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression: the OP_RETURN/MULTISIGN obfuscation key could bind to an
// outpoint that does not land at ins[0] when a BLOCKING foreign reservation
// lapses between key binding and input selection.
//
// The two phases sample the clock separately (nowFirst at pre-reservation, now at
// selection) with the async data loop in between, and _isOutpointReserved treats
// expiry <= now as free. So an earlier-sorted outpoint whose foreign reservation
// expired in that window is no longer skipped and takes ins[0], while the key
// stays bound to the outpoint this call pre-reserved. The decoder derives its
// deobfuscation key from ins[0].hash, so the magic-word check then fails and the
// action silently decodes to nothing: valid transaction, inputs spent, fee burned.
//
// These tests model the lapse by mutating the reservation map from inside a
// pass-through wrapper around obfuscate(), which is exactly the async window the
// finding names. Nothing in the reservation or selection logic is stubbed: the
// real _evictExpiredReservations / _isOutpointReserved / selection loop run, and
// the payload is really obfuscated and really deobfuscated.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  makeEncoder, makeSegwitUtxo, getTestAddress, TXID_A, TXID_B
} = require('../integration/helpers/utxoFactory')
const { deobfuscate } = require('../integration/helpers/deobfuscate')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'
const MAGIC = 'XCHN'
const FIVE_MINUTES = 5 * 60 * 1000
// secp256k1 generator point; the third (real) key of the 1-of-3 MULTISIGN output.
const COMPRESSED_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function ins0Txid (result) {
  return Buffer.from(result.psbt.txInputs[0].hash).reverse().toString('hex')
}

// Two equal-value tracker UTXOs. Equal values keep the encoder's sort stable, so
// TXID_A is the earlier-sorted candidate and TXID_B the later one.
function twoUtxoEncoder () {
  const encoder = makeEncoder(NETWORK)
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [makeSegwitUtxo(TXID_A, 0, 100000000), makeSegwitUtxo(TXID_B, 0, 100000000)]
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

describe('ins[0] / obfuscation-key binding @regression', function () {
  this.timeout(10000)

  it('OP_RETURN: a blocking reservation that lapses mid-build cannot steal ins[0]', async function () {
    const encoder = twoUtxoEncoder()
    const address = getTestAddress(NETWORK)

    // A concurrent create_tx holds TXID_A, so pre-reservation skips it and binds
    // the key to TXID_B. That reservation then lapses while the data loop runs.
    encoder.outpointReservations.set(TXID_A + ':0', Date.now() + FIVE_MINUTES)
    lapseReservationDuringDataLoop(encoder, () => {
      encoder.outpointReservations.set(TXID_A + ':0', Date.now() - 1)
    })

    const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)
    const result = await encoder.createTransaction(
      null, address, null, action.data, null, 10000, false, null, address,
      null, null, null, true, 0.00001
    )

    // Before the fix TXID_A was evicted by the selection pass and became ins[0]
    // while the key stayed bound to TXID_B.
    assert.strictEqual(ins0Txid(result), TXID_B,
      'the pre-reserved, key-bound outpoint must be ins[0]')

    const opReturn = result.psbt.txOutputs.find(o => o.value === 0)
    const obf = bitcoin.script.decompile(opReturn.script)[1]
    assert.strictEqual(deobfuscate(obf, ins0Txid(result)).subarray(0, 4).toString('utf8'), MAGIC,
      'the action must decode with ins[0].txid, which is the key the decoder uses')
  })

  it('MULTISIGN: same invariant on the bare-multisig payload path', async function () {
    const encoder = twoUtxoEncoder()
    const address = getTestAddress(NETWORK)

    encoder.outpointReservations.set(TXID_A + ':0', Date.now() + FIVE_MINUTES)
    lapseReservationDuringDataLoop(encoder, () => {
      encoder.outpointReservations.set(TXID_A + ':0', Date.now() - 1)
    })

    const action = actions.makeSend('JDOG', '7', actions.ADDR_BTC)
    const result = await encoder.createTransaction(
      null, address, null, action.data, null, 10000, false, 'MULTISIGN', address,
      null, null, COMPRESSED_PUBKEY, true, 0.00001
    )

    assert.strictEqual(result.encoding, 'MULTISIGN')
    assert.strictEqual(ins0Txid(result), TXID_B,
      'the pre-reserved, key-bound outpoint must be ins[0]')

    // Rebuild the payload from the two data-carrying pubkeys and check it decodes
    // under ins[0].txid.
    const msOut = result.psbt.txOutputs.find(o => {
      const d = bitcoin.script.decompile(o.script)
      return d && d.length === 6 && Buffer.isBuffer(d[1]) && d[1].length === 33
    })
    assert.ok(msOut, 'a bare-multisig data output must be present')
    const decompiled = bitcoin.script.decompile(msOut.script)
    let payload = Buffer.concat([decompiled[1].subarray(1), decompiled[2].subarray(1)])
    for (let i = payload.length - 1; i >= 0; i--) {
      if (payload[i] !== 0) { payload = payload.subarray(0, i + 1); break }
    }
    assert.strictEqual(deobfuscate(payload, ins0Txid(result)).subarray(0, 4).toString('utf8'), MAGIC,
      'the MULTISIGN action must decode with ins[0].txid')
  })

  it('fails closed when no outpoint could be pre-reserved and a different one frees', async function () {
    const encoder = twoUtxoEncoder()
    const address = getTestAddress(NETWORK)

    // Every fetched outpoint is already claimed, so pre-reservation establishes
    // nothing and the key falls back to utxos[0] (TXID_A). TXID_B then frees
    // before selection and becomes ins[0]. The splice cannot help here, so the
    // post-selection guard must refuse rather than emit a dead action.
    encoder.outpointReservations.set(TXID_A + ':0', Date.now() + FIVE_MINUTES)
    encoder.outpointReservations.set(TXID_B + ':0', Date.now() + FIVE_MINUTES)
    lapseReservationDuringDataLoop(encoder, () => {
      encoder.outpointReservations.set(TXID_B + ':0', Date.now() - 1)
    })

    const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)
    await assert.rejects(
      () => encoder.createTransaction(
        null, address, null, action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      ),
      err => {
        assert.strictEqual(err.name, 'OperationalError')
        assert.strictEqual(err.xchainCode, 'INPUT_SELECTION_RACE')
        assert.strictEqual(err.details.expectedFirstInput, TXID_A)
        assert.strictEqual(err.details.actualFirstInput, TXID_B)
        return true
      }
    )
  })

  it('does not double-add or double-reserve the spliced outpoint', async function () {
    const encoder = twoUtxoEncoder()
    const address = getTestAddress(NETWORK)

    encoder.outpointReservations.set(TXID_A + ':0', Date.now() + FIVE_MINUTES)
    lapseReservationDuringDataLoop(encoder, () => {
      encoder.outpointReservations.set(TXID_A + ':0', Date.now() - 1)
    })

    const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)
    const result = await encoder.createTransaction(
      null, address, null, action.data, null, 10000, false, null, address,
      null, null, null, true, 0.00001
    )

    // One 1-DOGE-equivalent input covers the outputs, so exactly one is taken and
    // the spliced outpoint must not appear twice.
    const seen = result.psbt.txInputs.map(i =>
      Buffer.from(i.hash).reverse().toString('hex') + ':' + i.index)
    assert.strictEqual(seen.length, 1, 'exactly one input should be selected')
    assert.strictEqual(new Set(seen).size, seen.length, 'no duplicate inputs')
    // TTL-based release only, so both the lapsed foreign entry (re-taken by this
    // call) and nothing else linger; the map must not accumulate phantom keys.
    assert.ok(encoder.outpointReservations.has(TXID_B + ':0'),
      'the selected outpoint stays reserved for its TTL')
    assert.ok(encoder.outpointReservations.size <= 2,
      `reservation map should not leak entries, saw ${encoder.outpointReservations.size}`)
  })

  it('caller-supplied UTXOs are untouched: no reservations, ins[0] is utxos[0]', async function () {
    const encoder = twoUtxoEncoder()
    const address = getTestAddress(NETWORK)
    const action = actions.makeSend()

    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], address, null,
      action.data, null, 10000, false, null, address,
      null, null, null, true, 0.00001
    )

    assert.strictEqual(ins0Txid(result), TXID_A)
    assert.strictEqual(encoder.outpointReservations.size, 0,
      'caller coin-control must not engage the reservation map')
    const opReturn = result.psbt.txOutputs.find(o => o.value === 0)
    const obf = bitcoin.script.decompile(opReturn.script)[1]
    assert.strictEqual(deobfuscate(obf, TXID_A).subarray(0, 4).toString('utf8'), MAGIC)
  })
})
