// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression: the key-path envelope cancel is the one build path outside
// _buildTransaction, and it must still take the outpoint reservation.
//
// createEnvelopeCancelTransaction returns a signable PSBT spending a
// caller-named commit outpoint. Without a claim on that outpoint the
// reservation map is blind to the cancel in both directions: a concurrent
// create_tx whose fetched set still carries the commit output selects and
// reserves it while an unsigned cancel of that same output is outstanding, and
// the cancel cannot see a claim another build already holds. The claim key must
// be lowercase, because this method accepts a mixed-case commitTxid while
// create_tx keys are canonicalized in validator.validateUtxoEntry, and an
// uppercase key can never collide with the reservation it is meant to see.
//
// The cancel is deterministic from the persisted recovery record, so the guard
// must stay retry-safe: re-taking its own live claim succeeds, and duplicate
// refusal is deliberately not applied to this path.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../src/XChainEncoder')
const actions = require('../integration/helpers/actionFactory')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

const NETWORK = 'bitcoin-regtest'
const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY_HEX = Buffer.from(KEY.publicKey).toString('hex')

const COMMIT_TXID = 'a'.repeat(64)
const OTHER_TXID = 'b'.repeat(64)
const TAPLEAF_HASH = 'c'.repeat(64)
const COMMIT_VOUT = 0
const COMMIT_KEY = COMMIT_TXID + ':' + COMMIT_VOUT
const FIVE_MINUTES = 5 * 60 * 1000

function makeEncoder () {
  const encoder = new XChainEncoder(NETWORK, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => { throw new Error('unit test: no node') }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
  }
  return encoder
}

function callerAddress (network) {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network }).address
}

function segwitUtxo (network, txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network })
  return { txid, vout, value, confirmations: 6, scriptPubKey: p2wpkh.output.toString('hex') }
}

// The persisted recovery record a wallet replays a cancel from.
function cancelRecord (encoder, overrides) {
  return Object.assign({
    commitTxid: COMMIT_TXID,
    commitVout: COMMIT_VOUT,
    commitValue: 100000,
    internalPubkey: PUBKEY_HEX,
    tapleafHash: TAPLEAF_HASH,
    destination: callerAddress(encoder.network)
  }, overrides || {})
}

function ins0Txid (result) {
  return Buffer.from(result.psbt.txInputs[0].hash).reverse().toString('hex')
}

describe('envelope-cancel outpoint reservation @regression', function () {
  this.timeout(10000)

  it('claims the commit outpoint on a successful cancel build', async function () {
    const encoder = makeEncoder()
    await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    assert.ok(encoder.outpointReservations.has(COMMIT_KEY),
      'a built cancel must hold the commit outpoint, or a concurrent create_tx can respend it')
  })

  it('normalizes a mixed-case commitTxid to the lowercase reservation key', async function () {
    const encoder = makeEncoder()
    await encoder.createEnvelopeCancelTransaction(
      cancelRecord(encoder, { commitTxid: COMMIT_TXID.toUpperCase() }))
    assert.ok(encoder.outpointReservations.has(COMMIT_KEY),
      'an uppercase key could never collide with the reservations create_tx takes')
    assert.strictEqual(encoder.outpointReservations.has(COMMIT_TXID.toUpperCase() + ':0'), false)
  })

  it('a live cancel claim keeps create_tx from selecting the commit outpoint', async function () {
    const encoder = makeEncoder()
    const address = callerAddress(encoder.network)
    const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)

    await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))

    // Equal values keep the sort stable, so the commit outpoint would be a
    // candidate for ins[0] if the cancel had left it unreserved.
    const utxos = [
      segwitUtxo(encoder.network, COMMIT_TXID, COMMIT_VOUT, 100000000),
      segwitUtxo(encoder.network, OTHER_TXID, 0, 100000000)
    ]
    const result = await encoder.createTransaction(
      utxos, address, null, action.data, null, 10000, false, null, address,
      null, null, null, true, 0.00001
    )
    const spent = result.psbt.txInputs.map(
      (i) => Buffer.from(i.hash).reverse().toString('hex'))
    assert.ok(!spent.includes(COMMIT_TXID),
      'create_tx must not spend an outpoint an outstanding unsigned cancel already spends')
    assert.strictEqual(ins0Txid(result), OTHER_TXID)
  })

  it('refuses a cancel of an outpoint another build holds', async function () {
    const encoder = makeEncoder()
    // A foreign in-flight create_tx claim on the commit output.
    encoder.outpointReservations.set(COMMIT_KEY, Date.now() + FIVE_MINUTES)

    await assert.rejects(
      encoder.createEnvelopeCancelTransaction(cancelRecord(encoder)),
      (err) => err.operational === true &&
        err.xchainCode === 'ENVELOPE_CANCEL_OUTPOINT_RESERVED' &&
        err.details.outpoint === COMMIT_KEY)
  })

  it('stays retry-safe: a repeat cancel rebuilds the byte-identical PSBT', async function () {
    const encoder = makeEncoder()
    const first = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    const second = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    assert.strictEqual(second.psbt.toHex(), first.psbt.toHex(),
      'a cancel replayed from the recovery record must not be refused as a duplicate')
    assert.ok(encoder.outpointReservations.has(COMMIT_KEY))
  })

  it('releases the claim when the build throws', async function () {
    const encoder = makeEncoder()
    await assert.rejects(
      // Commit value below the dust floor: throws after the claim is taken.
      encoder.createEnvelopeCancelTransaction(cancelRecord(encoder, { commitValue: 600 })),
      (err) => err.xchainCode === 'ENVELOPE_CANCEL_BELOW_DUST')
    assert.strictEqual(encoder.outpointReservations.has(COMMIT_KEY), false,
      'a failed cancel must not squat the commit outpoint for the reservation window')
    assert.strictEqual(encoder.envelopeCancelClaims.has(COMMIT_KEY), false)
  })

  it('a foreign claim taken after the cancel is never dropped by its release', async function () {
    const encoder = makeEncoder()
    await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    // The cancel's claim lapses and another build re-reserves the outpoint.
    const foreignExpiry = Date.now() + FIVE_MINUTES + 1000
    encoder.outpointReservations.set(COMMIT_KEY, foreignExpiry)

    await assert.rejects(
      encoder.createEnvelopeCancelTransaction(cancelRecord(encoder, { commitValue: 600 })),
      (err) => err.xchainCode === 'ENVELOPE_CANCEL_OUTPOINT_RESERVED')
    assert.strictEqual(encoder.outpointReservations.get(COMMIT_KEY), foreignExpiry,
      'dropping a foreign entry would reopen the double-spend window the map closes')
  })

  it('clearReservations drops the cancel ownership stamps too', async function () {
    const encoder = makeEncoder()
    await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    encoder.clearReservations()
    assert.strictEqual(encoder.envelopeCancelClaims.size, 0,
      'a stale stamp would let a foreign claim read as this path\'s own')
  })

  // A lost-response retry legitimately re-claims an outpoint the first build is
  // still outstanding on. While ownership was one expiry stamp per outpoint, the
  // retry overwrote it and its own failure then deleted the reservation outright,
  // handing the commit outpoint to create_tx while the first unsigned cancel was
  // still spending it. Ownership is a per-build token set now: the last owner out
  // frees the outpoint, nobody else.
  it('a failed retry leaves the outstanding cancel\'s reservation in place', async function () {
    const encoder = makeEncoder()
    const first = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    const firstExpiry = encoder.outpointReservations.get(COMMIT_KEY)

    await assert.rejects(
      // Below the dust floor: throws after the retry has taken its own claim.
      encoder.createEnvelopeCancelTransaction(cancelRecord(encoder, { commitValue: 600 })),
      (err) => err.xchainCode === 'ENVELOPE_CANCEL_BELOW_DUST')

    assert.strictEqual(encoder.outpointReservations.get(COMMIT_KEY), firstExpiry,
      'the retry\'s failure must hand back only its own claim, not the outstanding build\'s')
    assert.ok(first.reservation, 'the successful build must carry a release ticket')
  })

  it('create_tx still cannot select the commit outpoint after a failed retry', async function () {
    const encoder = makeEncoder()
    const address = callerAddress(encoder.network)
    const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)

    await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    await assert.rejects(
      encoder.createEnvelopeCancelTransaction(cancelRecord(encoder, { commitValue: 600 })),
      (err) => err.xchainCode === 'ENVELOPE_CANCEL_BELOW_DUST')

    const utxos = [
      segwitUtxo(encoder.network, COMMIT_TXID, COMMIT_VOUT, 100000000),
      segwitUtxo(encoder.network, OTHER_TXID, 0, 100000000)
    ]
    const result = await encoder.createTransaction(
      utxos, address, null, action.data, null, 10000, false, null, address,
      null, null, null, true, 0.00001
    )
    const spent = result.psbt.txInputs.map(
      (i) => Buffer.from(i.hash).reverse().toString('hex'))
    assert.ok(!spent.includes(COMMIT_TXID),
      'a retry\'s failure must not free an outpoint an outstanding unsigned cancel spends')
  })

  it('the first build\'s ticket still releases after a failed retry', async function () {
    const encoder = makeEncoder()
    const first = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    await assert.rejects(
      encoder.createEnvelopeCancelTransaction(cancelRecord(encoder, { commitValue: 600 })),
      (err) => err.xchainCode === 'ENVELOPE_CANCEL_BELOW_DUST')

    const released = encoder.releaseReservation(first.reservation.id)
    assert.deepStrictEqual(released.released, [COMMIT_KEY],
      'the outstanding build\'s receipt must still work; a moved stamp reported it retained')
    assert.strictEqual(encoder.outpointReservations.has(COMMIT_KEY), false)
    assert.strictEqual(encoder.envelopeCancelClaims.has(COMMIT_KEY), false)
  })

  it('last cancel owner out frees the outpoint, not the first', async function () {
    const encoder = makeEncoder()
    const first = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    const second = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))

    const firstRelease = encoder.releaseReservation(first.reservation.id)
    assert.deepStrictEqual(firstRelease.retained, [COMMIT_KEY],
      'the second build is still outstanding, so the outpoint stays reserved')
    assert.strictEqual(encoder.outpointReservations.has(COMMIT_KEY), true)

    const secondRelease = encoder.releaseReservation(second.reservation.id)
    assert.deepStrictEqual(secondRelease.released, [COMMIT_KEY])
    assert.strictEqual(encoder.outpointReservations.has(COMMIT_KEY), false)
    assert.strictEqual(encoder.envelopeCancelClaims.has(COMMIT_KEY), false)
  })

  it('three overlapping builds: an out-of-order failure frees nothing', async function () {
    const encoder = makeEncoder()
    const first = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    const second = await encoder.createEnvelopeCancelTransaction(cancelRecord(encoder))
    await assert.rejects(
      encoder.createEnvelopeCancelTransaction(cancelRecord(encoder, { commitValue: 600 })),
      (err) => err.xchainCode === 'ENVELOPE_CANCEL_BELOW_DUST')
    assert.strictEqual(encoder.outpointReservations.has(COMMIT_KEY), true)

    encoder.releaseReservation(second.reservation.id)
    assert.strictEqual(encoder.outpointReservations.has(COMMIT_KEY), true,
      'the first build is still outstanding')
    encoder.releaseReservation(first.reservation.id)
    assert.strictEqual(encoder.outpointReservations.has(COMMIT_KEY), false)
    assert.strictEqual(encoder.envelopeCancelClaims.size, 0)
  })
})
