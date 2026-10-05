// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const { OperationalError } = require('../../../../src/build/errors')
const { RESERVATION_TTL_MS } = require('../../../../src/XChainEncoder/constants')
const reservations = require('../../../../src/XChainEncoder/outpoint_reservations')
const { bindObfuscationKey } = require(
  '../../../../src/XChainEncoder/build_transaction/first_input_key'
)

const TXID_FIRST = 'A'.repeat(64)
const TXID_AVAILABLE = 'B'.repeat(64)
const NOW = 1700000000000

function makeContext () {
  return Object.assign({ outpointReservations: new Map() }, reservations)
}

function withFixedNow (run) {
  const realNow = Date.now
  Date.now = () => NOW
  try {
    return run()
  } finally {
    Date.now = realNow
  }
}

describe('bindObfuscationKey', () => {
  it('binds the key to the available outpoint moved into the first-input slot', () => {
    const context = makeContext()
    const firstKey = `${TXID_FIRST}:0`
    context.outpointReservations.set(firstKey, NOW + 1)
    const build = {
      utxos: [
        { txid: TXID_FIRST, vout: 0 },
        { txid: TXID_AVAILABLE, vout: 1 }
      ],
      exactInputs: false,
      callReservations: []
    }

    withFixedNow(() => bindObfuscationKey.call(context, build))

    assert.strictEqual(build.utxos[0].txid, TXID_AVAILABLE)
    assert.strictEqual(build.txidFirstInput, TXID_AVAILABLE.toLowerCase())
    assert.strictEqual(build.firstReservedOutpoint, `${TXID_AVAILABLE}:1`)
  })
})

describe('bindObfuscationKey exact inputs', () => {
  it('raises OperationalError when exact mode cannot claim its first input', () => {
    const context = makeContext()
    const firstKey = `${TXID_FIRST}:0`
    context.outpointReservations.set(firstKey, NOW + 1)
    const build = {
      utxos: [{ txid: TXID_FIRST, vout: 0 }],
      exactInputs: true,
      callReservations: []
    }

    assert.throws(
      () => withFixedNow(() => bindObfuscationKey.call(context, build)),
      (error) => {
        assert.ok(error instanceof OperationalError)
        assert.strictEqual(error.xchainCode, 'INPUT_RESERVED')
        assert.deepStrictEqual(error.details, { reserved: [firstKey] })
        assert.match(error.message, new RegExp(
          `${Math.round(RESERVATION_TTL_MS / 60000)} minutes`
        ))
        return true
      }
    )
  })
})

describe('bindObfuscationKey reservation lifetime', () => {
  it('reserves the first input for the configured TTL', () => {
    const context = makeContext()
    const callReservations = []
    const key = `${TXID_FIRST}:2`
    const build = {
      utxos: [{ txid: TXID_FIRST, vout: 2 }],
      exactInputs: false,
      callReservations
    }

    withFixedNow(() => bindObfuscationKey.call(context, build))

    assert.strictEqual(context.outpointReservations.get(key), NOW + RESERVATION_TTL_MS)
    assert.deepStrictEqual(callReservations, [
      { key, expiry: NOW + RESERVATION_TTL_MS }
    ])
  })
})
