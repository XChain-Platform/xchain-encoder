// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Pins the error-code registry split on the build path: -32602 means "fix the
// params, do not retry" and -32603 means "retry with backoff". Each case runs
// the real build behind a fresh controller and a stubbed node and tracker.

const assert = require('assert')
const { createJsonRpcController } = require('../../src/api/json_rpc_methods')
const { ParamTypeError } = require('../../src/build/errors')
const { TXID_A, PUBKEY_BUF, makeEncoder, getTestAddress } = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'bitcoin-regtest'
const address = getTestAddress(NETWORK)

// Run one JSON-RPC method against a fresh stubbed encoder and return its rejection.
async function rejectionOf (method, mutate, params) {
  const encoder = makeEncoder(NETWORK)
  if (mutate) mutate(encoder)
  const controller = createJsonRpcController({ encoder, NETWORK })
  try {
    await controller[method](params)
  } catch (e) {
    return e
  }
  assert.fail(`${method} should reject`)
}

// A create_tx request the validator accepts, with the given overrides.
function sendParams (extra) {
  return Object.assign({ pubkey: address, data: actions.makeSend().data, change: address, unconfirmed: true }, extra)
}

// Report a node that answers getnetworkinfo without a usable relay floor.
function noRelayFee (encoder) {
  encoder.connector.getNetworkInfo = async () => ({ relayfee: 0 })
}

describe('REG-32: create_tx answers a caller fault with -32602', () => {
  it('keeps the reason for a fee below the node relay minimum', async () => {
    const caught = await rejectionOf('create_tx', null, sendParams({ fee: 1 }))
    assert.strictEqual(caught.code, -32602)
    assert.ok(/below the node relay minimum/.test(caught.message), caught.message)
  })

  // The compression guards raise through refuse(ErrorClass, ...), never a literal `new`.
  it('keeps the reason for an explicit compress request on a non-FILE action', async () => {
    const caught = await rejectionOf('create_tx', null, sendParams({ compress: true, rawData: 'a'.repeat(64) }))
    assert.strictEqual(caught.code, -32602)
    assert.ok(/COMPRESSION is a FILE v0 field/.test(caught.message), caught.message)
  })

  it('keeps the message of a TypeError the build raises', async () => {
    const caught = await rejectionOf('create_tx', (encoder) => {
      encoder.createTransaction = async () => { throw new ParamTypeError('Unknown encoding: "FOO"') }
    }, sendParams())
    assert.strictEqual(caught.code, -32602)
    assert.strictEqual(caught.message, 'Unknown encoding: "FOO"')
  })
})

describe('REG-32: create_tx answers a server fault with -32603 or a tracker error', () => {
  it('answers -32603, generic, when the node reports no relayfee', async () => {
    const caught = await rejectionOf('create_tx', noRelayFee, sendParams())
    assert.strictEqual(caught.code, -32603)
    assert.strictEqual(caught.message, 'Internal encoder error')
  })

  it('answers UTXO_TRACKER_ERROR, never -32602, for a malformed tracker row', async () => {
    const caught = await rejectionOf('create_tx', (encoder) => {
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: [{ txid: TXID_A, vout: -1, value: 100000000, scriptPubKey: '0014' + '11'.repeat(20), confirmations: 1 }]
      })
    }, sendParams())
    assert.strictEqual(caught.code, -32010)
    assert.strictEqual(caught.data.reason, 'UTXO_TRACKER_ERROR')
  })
})

describe('REG-32: create_envelope_cancel_tx draws the same line as create_tx', () => {
  it('answers -32602 with the reason for a feePerKb below the relay minimum', async () => {
    const caught = await rejectionOf('create_envelope_cancel_tx', null, {
      commitTxid: TXID_A,
      commitVout: 0,
      commitValue: 100000,
      internalPubkey: PUBKEY_BUF.toString('hex'),
      tapleafHash: 'c'.repeat(64),
      destination: address,
      feePerKb: 1
    })
    assert.strictEqual(caught.code, -32602)
    assert.ok(/below the node relay minimum/.test(caught.message), caught.message)
  })
})

describe('REG-32: the other build paths keep node faults off -32602', () => {
  it('answers -32603 from create_envelope_cancel_tx when the node reports no relayfee', async () => {
    const caught = await rejectionOf('create_envelope_cancel_tx', noRelayFee, {
      commitTxid: TXID_A,
      commitVout: 0,
      commitValue: 100000,
      internalPubkey: PUBKEY_BUF.toString('hex'),
      tapleafHash: 'c'.repeat(64),
      destination: address
    })
    assert.strictEqual(caught.code, -32603)
    assert.strictEqual(caught.message, 'Internal encoder error')
  })

  it('raises a plain Error, not a RangeError, from the output-uplift invariant', () => {
    const encoder = makeEncoder(NETWORK)
    assert.throws(() => encoder.raiseOutputValue(null, 0, 0),
      (err) => err.constructor === Error && /output uplift must be a positive integer/.test(err.message))
  })
})

// A native or library TypeError/RangeError is a bug, not a caller fault: logged, retryable, generic.
describe('REG-32: an unmarked TypeError or RangeError from the build is an internal error', () => {
  const NATIVE = "Cannot read properties of undefined (reading 'x')"
  const cancelParams = {
    commitTxid: TXID_A,
    commitVout: 0,
    commitValue: 100000,
    internalPubkey: PUBKEY_BUF.toString('hex'),
    tapleafHash: 'c'.repeat(64),
    destination: address
  }
  const cases = [
    ['create_tx', (enc, err) => { enc.createTransaction = async () => { throw err } }, sendParams()],
    ['create_envelope_cancel_tx', (enc, err) => { enc.createEnvelopeCancelTransaction = async () => { throw err } }, cancelParams],
    ['release_inputs', (enc, err) => { enc.releaseReservation = () => { throw err } }, { reservationId: 'f'.repeat(32) }]
  ]

  for (const [method, stub, params] of cases) {
    for (const make of [() => new TypeError(NATIVE), () => new RangeError('Invalid array length')]) {
      const kind = make().name
      it(method + ' answers -32603, generic, for a native ' + kind, async () => {
        const caught = await rejectionOf(method, (enc) => stub(enc, make()), params)
        assert.strictEqual(caught.code, -32603)
        assert.strictEqual(caught.message, 'Internal encoder error')
      })
    }
  }
})
