// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A mainnet encoder refuses create_tx for non-validator actions before 1798761600,
// with MAINNET_PRELAUNCH, unless the operator sets ENCODER_MAINNET_PRELAUNCH_OVERRIDE.

const assert = require('assert')
const { createJsonRpcController, MAINNET_LAUNCH_TS } = require('../../../src/api/json_rpc_methods')
const { makeEncoder, getTestAddress } = require('../../integration/helpers/utxoFactory')
const actions = require('../../integration/helpers/actionFactory')

const ENV = 'ENCODER_MAINNET_PRELAUNCH_OVERRIDE'
const BEFORE = () => (MAINNET_LAUNCH_TS - 60) * 1000
const AT = () => MAINNET_LAUNCH_TS * 1000

function setup (network, extra = {}) {
  const encoder = makeEncoder(network)
  let built = 0
  encoder.createTransaction = async () => {
    built++
    return { psbt: { toHex: () => 'aa' } }
  }
  const address = getTestAddress(network)
  const controller = createJsonRpcController({ encoder, NETWORK: network, now: BEFORE, ...extra })
  return { controller, address, built: () => built }
}
const params = (address, data) => ({ pubkey: address, data, change: address, unconfirmed: true, feePerKb: 5000 })

describe('mainnet prelaunch refusal', () => {
  let saved
  beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV] })
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved })

  it('refuses a non-validator action before launch as -32010 MAINNET_PRELAUNCH', async () => {
    const { controller, address, built } = setup('bitcoin-mainnet')
    await assert.rejects(controller.create_tx(params(address, actions.makeSend().data)), (err) => {
      assert.strictEqual(err.code, -32010)
      assert.strictEqual(err.data.reason, 'MAINNET_PRELAUNCH')
      assert.strictEqual(err.data.opens_at, MAINNET_LAUNCH_TS)
      return true
    })
    assert.strictEqual(built(), 0)
  })

  it('refuses an alias of a non-validator action (TRANSFER)', async () => {
    const { controller, address } = setup('bitcoin-mainnet')
    await assert.rejects(controller.create_tx(params(address, 'TRANSFER|0|JDOG|1|' + address)),
      (err) => err.data.reason === 'MAINNET_PRELAUNCH')
  })

  for (const name of ['STAKE', 'UNSTAKE', 'DELEGATE', 'SLASH', 'NODEPROOF', 'ROLLCALL']) {
    it(`lets ${name} through before launch`, async () => {
      const { controller, address, built } = setup('bitcoin-mainnet')
      let refusal = null
      try { await controller.create_tx(params(address, name + '|x')) } catch (err) { refusal = err }
      // Either the stub build ran, or a later param check spoke; never the prelaunch gate.
      assert.ok(built() === 1 || (refusal && !(refusal.data && refusal.data.reason === 'MAINNET_PRELAUNCH')))
    })
  }

  it('builds a non-validator action at and after launch', async () => {
    const { controller, address, built } = setup('bitcoin-mainnet', { now: AT })
    await controller.create_tx(params(address, actions.makeSend().data))
    assert.strictEqual(built(), 1)
  })

  it('never refuses a testnet encoder', async () => {
    const { controller, address, built } = setup('bitcoin-testnet')
    await controller.create_tx(params(address, actions.makeSend().data))
    assert.strictEqual(built(), 1)
  })

  describe('operator override via the environment variable', () => {
    for (const value of ['1', 'true', 'YES', 'on']) {
      it(`${ENV}=${value} lifts the refusal with no factory option`, async () => {
        const { controller, address, built } = setup('bitcoin-mainnet')
        process.env[ENV] = value
        await controller.create_tx(params(address, actions.makeSend().data))
        assert.strictEqual(built(), 1)
      })
    }

    it('is read live: unsetting it restores the refusal on the same controller', async () => {
      const { controller, address } = setup('bitcoin-mainnet')
      process.env[ENV] = '1'
      await controller.create_tx(params(address, actions.makeSend().data))
      delete process.env[ENV]
      await assert.rejects(controller.create_tx(params(address, actions.makeSend().data)),
        (err) => err.data.reason === 'MAINNET_PRELAUNCH')
    })

    for (const value of ['0', 'false', '', 'maybe']) {
      it(`${ENV}=${JSON.stringify(value)} leaves the refusal in force`, async () => {
        const { controller, address } = setup('bitcoin-mainnet')
        process.env[ENV] = value
        await assert.rejects(controller.create_tx(params(address, actions.makeSend().data)),
          (err) => err.data.reason === 'MAINNET_PRELAUNCH')
      })
    }
  })
})
