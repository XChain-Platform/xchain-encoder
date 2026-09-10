// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Ownership-stamped release of input reservations.
//
// A successful build keeps its inputs reserved for five minutes because the
// caller is expected to sign and broadcast them. The wallet composes when its
// send modal OPENS, and most of those builds are abandoned, so on a few-UTXO
// address the next compose met its own money already claimed and reported
// insufficient funds (observed live on TDOGE). create_tx now hands back a
// reservation receipt and release_inputs gives those inputs back on demand,
// without giving any caller a lever over another call's claims.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_ONE = 'a'.repeat(64)
const TXID_TWO = 'b'.repeat(64)

const LTC_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('litecoin-regtest')
const TEST_ADDRESS = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: LTC_REGTEST }).address
const PUBKEY_HEX = pubkeyBuf.toString('hex')

function makeSegwitUtxo (txid, vout, value, confirmations = 6) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest })
  return { txid, vout, value, confirmations, scriptPubKey: p2wpkh.output.toString('hex') }
}

// Segwit-capable test chain, both upstreams stubbed: nothing here should reach a
// node or the tracker, and a call that tries to is a defect in the test.
function makeEncoder () {
  const encoder = new XChainEncoder('litecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => { throw new Error('no non-segwit input expected in this suite') }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('these builds supply their own utxos') }
  }
  return encoder
}

// createTransaction is positional; name the tail so the tests read as intent.
function createTx (encoder, utxos, overrides = {}) {
  const o = Object.assign({
    customOutputs: null, data: null, rawData: null, fee: 10000, rbf: false,
    encoding: null, change: TEST_ADDRESS, p2shHash: null, p2shHex: null,
    compressedPubKey: null, unconfirmed: true, options: null
  }, overrides)
  return encoder.createTransaction(
    utxos, PUBKEY_HEX, o.customOutputs, o.data, o.rawData, o.fee, o.rbf,
    o.encoding, o.change, o.p2shHash, o.p2shHex, o.compressedPubKey,
    o.unconfirmed, null, null, null, false, null, o.options)
}

// The shape the live defect had: a funded address whose whole balance is one
// spendable output, so the second compose has nothing left to select.
function oneFundedUtxo () {
  return [makeSegwitUtxo(TXID_ONE, 0, 5000000)]
}

describe('XChainEncoder reservation release', () => {

  it('a successful build returns a receipt naming the outpoints it reserved', async () => {
    const encoder = makeEncoder()
    const result = await createTx(encoder, oneFundedUtxo())
    assert.ok(result.reservation, 'build kept reservations but returned no receipt')
    assert.deepStrictEqual(result.reservation.outpoints, [`${TXID_ONE}:0`])
    assert.match(result.reservation.id, /^[0-9a-f]{32}$/)
    assert.ok(result.reservation.expiresAt > Date.now())
    // The receipt describes real state, not a label: that outpoint is claimed.
    assert.strictEqual(encoder._isOutpointReserved(`${TXID_ONE}:0`, Date.now()), true)
  })

  it('releasing frees the inputs, so the next compose funds instead of failing', async () => {
    const encoder = makeEncoder()
    const first = await createTx(encoder, oneFundedUtxo())

    // Without the release this is the live defect, pinned here so the fix is
    // measured against the real failure and not against a flag.
    await assert.rejects(
      () => createTx(encoder, oneFundedUtxo(), { fee: 11000 }),
      (err) => err.operational === true && err.xchainCode === 'INSUFFICIENT_FUNDS'
    )

    const release = encoder.releaseReservation(first.reservation.id)
    assert.strictEqual(release.found, true)
    assert.deepStrictEqual(release.released, [`${TXID_ONE}:0`])
    assert.deepStrictEqual(release.retained, [])

    const second = await createTx(encoder, oneFundedUtxo(), { fee: 11000 })
    assert.strictEqual(second.psbt.txInputs.length, 1)
  })

  it('releasing retires the duplicate-build refusal for that same build', async () => {
    // Freeing the inputs alone just moves the five-minute wall: the recompose
    // after a release is byte-identical by construction, so the duplicate guard
    // would refuse it for the rest of the window.
    const encoder = makeEncoder()
    const first = await createTx(encoder, oneFundedUtxo())
    encoder.releaseReservation(first.reservation.id)
    const again = await createTx(encoder, oneFundedUtxo())
    assert.strictEqual(again.psbt.txInputs.length, 1)
  })

  it('a foreign ticket id releases nothing and leaves the claims standing', async () => {
    const encoder = makeEncoder()
    await createTx(encoder, oneFundedUtxo())
    const out = encoder.releaseReservation('f'.repeat(32))
    assert.strictEqual(out.found, false)
    assert.deepStrictEqual(out.released, [])
    assert.strictEqual(encoder._isOutpointReserved(`${TXID_ONE}:0`, Date.now()), true)
    // And the address is still held, which is the point of refusing the release.
    await assert.rejects(
      () => createTx(encoder, oneFundedUtxo(), { fee: 11000 }),
      (err) => err.xchainCode === 'INSUFFICIENT_FUNDS'
    )
  })

  it('a claim another call has since re-taken is retained, never dropped', async () => {
    // The stamp is the ownership proof. Once this build's claim lapses and a
    // concurrent build re-reserves the outpoint against a later clock, the map
    // value no longer matches the ticket, and dropping it would reopen the
    // same-address double-spend window the reservation map exists to close.
    const encoder = makeEncoder()
    const first = await createTx(encoder, oneFundedUtxo())
    const key = `${TXID_ONE}:0`
    const foreignExpiry = encoder.outpointReservations.get(key) + 60000
    encoder.outpointReservations.set(key, foreignExpiry)

    const out = encoder.releaseReservation(first.reservation.id)
    assert.strictEqual(out.found, true)
    assert.deepStrictEqual(out.released, [])
    assert.deepStrictEqual(out.retained, [key])
    assert.strictEqual(encoder.outpointReservations.get(key), foreignExpiry,
      'a foreign claim was dropped by another caller\'s release')
  })

  it('is idempotent: a second release of the same ticket reports nothing to do', async () => {
    const encoder = makeEncoder()
    const first = await createTx(encoder, oneFundedUtxo())
    assert.strictEqual(encoder.releaseReservation(first.reservation.id).found, true)
    const second = encoder.releaseReservation(first.reservation.id)
    assert.strictEqual(second.found, false)
    assert.deepStrictEqual(second.released, [])
  })

  it('releases only the presented build\'s claims, not a concurrent build\'s', async () => {
    const encoder = makeEncoder()
    const utxos = [makeSegwitUtxo(TXID_ONE, 0, 5000000), makeSegwitUtxo(TXID_TWO, 1, 4000000)]
    const first = await createTx(encoder, utxos)
    const firstKey = first.reservation.outpoints[0]
    // The second build skips the reserved outpoint and claims the other one.
    const second = await createTx(encoder, utxos, { fee: 11000 })
    const secondKey = second.reservation.outpoints[0]
    assert.notStrictEqual(firstKey, secondKey)

    const out = encoder.releaseReservation(first.reservation.id)
    assert.deepStrictEqual(out.released, [firstKey])
    assert.strictEqual(encoder._isOutpointReserved(firstKey, Date.now()), false)
    assert.strictEqual(encoder._isOutpointReserved(secondKey, Date.now()), true)
  })

  it('refuses a malformed ticket id with a TypeError, before touching any state', async () => {
    const encoder = makeEncoder()
    await createTx(encoder, oneFundedUtxo())
    for (const bad of [null, undefined, 42, {}, 'nothex', 'A'.repeat(32), 'f'.repeat(31)]) {
      assert.throws(() => encoder.releaseReservation(bad), TypeError, `accepted ${String(bad)}`)
    }
    assert.strictEqual(encoder._isOutpointReserved(`${TXID_ONE}:0`, Date.now()), true)
  })

  it('mints no receipt when the build kept no claims', async () => {
    // The p2sh/p2wsh reveal funds itself from phase-1 outputs and runs no input
    // selection, so there is nothing to release and no ticket to hand out.
    const encoder = makeEncoder()
    const ticket = encoder._mintReservationTicket([], Date.now())
    assert.strictEqual(ticket, null)
    assert.strictEqual(encoder.reservationTickets.size, 0)
  })

  it('sweeps expired tickets so the ticket map cannot outgrow the reservations', async () => {
    const encoder = makeEncoder()
    const first = await createTx(encoder, oneFundedUtxo())
    assert.strictEqual(encoder.reservationTickets.size, 1)
    const ticket = encoder.reservationTickets.get(first.reservation.id)
    encoder._evictExpiredReservationTickets(ticket.expiry + 1)
    assert.strictEqual(encoder.reservationTickets.size, 0)
    assert.strictEqual(encoder.releaseReservation(first.reservation.id).found, false)
  })
})

describe('release_inputs JSON-RPC method', () => {
  const { jsonRpcController, encoder } = require('../../src/api')

  afterEach(() => encoder.clearReservations())

  it('releases the claims the presented ticket owns', async () => {
    const claims = []
    const key = `${TXID_TWO}:7`
    encoder._claimOutpoint(claims, key, Date.now())
    const receipt = encoder._mintReservationTicket(claims, Date.now())
    const out = await jsonRpcController.release_inputs({ reservationId: receipt.id })
    assert.strictEqual(out.found, true)
    assert.deepStrictEqual(out.released, [key])
    assert.strictEqual(encoder._isOutpointReserved(key, Date.now()), false)
  })

  it('answers an unknown ticket with found:false rather than an error', async () => {
    const out = await jsonRpcController.release_inputs({ reservationId: '0'.repeat(32) })
    assert.strictEqual(out.found, false)
    assert.deepStrictEqual(out.released, [])
  })

  it('maps a malformed or missing reservationId to invalid params', async () => {
    for (const params of [{}, { reservationId: 'zz' }, { reservationId: 7 }, [], null]) {
      await assert.rejects(
        () => jsonRpcController.release_inputs(params),
        (err) => err.code === -32602,
        `accepted ${JSON.stringify(params)}`
      )
    }
  })
})
