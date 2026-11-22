'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const { createJsonRpcController } = require('../../../../src/api/json_rpc_methods')

function controllerFor (network, relayfee, rates) {
  const encoder = {
    connector: {
      assertNodeTier: async () => {},
      getNetworkInfo: async () => ({ relayfee }),
      getFeePerKilobyte: async target => rates[target]
    }
  }
  return createJsonRpcController({ encoder, NETWORK: network })
}

describe('estimate_fee relay floor parity', function () {
  it('quotes the DOGE testnet ceiling raised to ten times relay', async function () {
    const controller = controllerFor('dogecoin-testnet', 0.001, { 6: 0.01, 3: 0.01, 1: 0.01 })
    assert.deepStrictEqual(await controller.estimate_fee(), { low: 1000, medium: 1000, high: 1000 })
  })

  it('clamps a high DOGE estimate at the raised ceiling', async function () {
    const controller = controllerFor('dogecoin-testnet', 0.001, { 6: 0.05, 3: 0.05, 1: 0.05 })
    assert.deepStrictEqual(await controller.estimate_fee(), { low: 1000, medium: 1000, high: 1000 })
  })

  it('never quotes below the DOGE relay floor', async function () {
    const controller = controllerFor('dogecoin-regtest', 0.001, { 6: 0.0005, 3: 0.0005, 1: 0.0005 })
    assert.deepStrictEqual(await controller.estimate_fee(), { low: 100, medium: 100, high: 100 })
  })

  it('keeps the Bitcoin test-chain ceiling and mainnet rate unchanged', async function () {
    const testnet = controllerFor('bitcoin-testnet', 0.00001, { 6: 0.00376, 3: 0.00376, 1: 0.00376 })
    const mainnet = controllerFor('bitcoin-mainnet', 0.00001, { 6: 0.00005, 3: 0.00005, 1: 0.00005 })
    assert.deepStrictEqual(await testnet.estimate_fee(), { low: 20, medium: 20, high: 20 })
    assert.deepStrictEqual(await mainnet.estimate_fee(), { low: 5, medium: 5, high: 5 })
  })

  it('refuses a quote when the node supplies no positive relay floor', async function () {
    const controller = controllerFor('dogecoin-testnet', undefined, { 6: 0.01, 3: 0.01, 1: 0.01 })
    await assert.rejects(controller.estimate_fee(), error => error.code === -32603)
  })
})
