'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

function controllerFor (rates, calls = []) {
  const encoder = {
    connector: {
      assertNodeTier: async () => {},
      getFeePerKilobyte: async target => {
        calls.push(target)
        return rates[target]
      }
    }
  }
  return createJsonRpcController({ encoder, NETWORK: 'bitcoin-mainnet' })
}

describe('estimate_fee tier ordering', function () {
  it('lifts faster tiers to the slower tier when node estimates decrease', async function () {
    const calls = []
    const controller = controllerFor({ 6: 0.00005, 3: 0.00001, 1: 0.00001 }, calls)

    assert.deepStrictEqual(await controller.estimate_fee(), { low: 5, medium: 5, high: 5 })
    assert.deepStrictEqual(calls, [6, 3, 1])
  })

  it('preserves increases while lifting a later dip', async function () {
    const controller = controllerFor({ 6: 0.00001, 3: 0.00003, 1: 0.00002 })

    assert.deepStrictEqual(await controller.estimate_fee(), { low: 1, medium: 3, high: 3 })
  })
})
