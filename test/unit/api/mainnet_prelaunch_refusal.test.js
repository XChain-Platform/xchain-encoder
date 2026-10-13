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
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')
const { MAINNET_LAUNCH_TS } = require('../../../src/common/config')
const { makeEncoder, getTestAddress } = require('../../integration/helpers/utxoFactory')
const actions = require('../../integration/helpers/actionFactory')

const ENV = 'ENCODER_MAINNET_PRELAUNCH_OVERRIDE'
const BEFORE = (MAINNET_LAUNCH_TS - 60) * 1000
const AT = MAINNET_LAUNCH_TS * 1000

let built, address, controller, savedEnv, realNow

function setup (network, clock = BEFORE) {
  const encoder = makeEncoder(network)
  built = 0
  encoder.createTransaction = async () => {
    built++
    return { psbt: { toHex: () => 'aa' } }
  }
  address = getTestAddress(network)
  controller = createJsonRpcController({ encoder, NETWORK: network })
  Date.now = () => clock
}
const params = (data) => ({ pubkey: address, data, change: address, unconfirmed: true, feePerKb: 5000 })
const send = () => controller.create_tx(params(actions.makeSend().data))
const isPrelaunch = (err) => err.data.reason === 'MAINNET_PRELAUNCH'

function isolateClockAndEnv () {
  beforeEach(() => { savedEnv = process.env[ENV]; realNow = Date.now; delete process.env[ENV] })
  afterEach(() => {
    Date.now = realNow
    if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv
  })
}

describe('mainnet prelaunch refusal', () => {
  isolateClockAndEnv()

  it('refuses a non-validator action before launch as -32010 MAINNET_PRELAUNCH', async () => {
    setup('bitcoin-mainnet')
    await assert.rejects(send(), (err) => {
      assert.strictEqual(err.code, -32010)
      assert.strictEqual(err.data.reason, 'MAINNET_PRELAUNCH')
      assert.strictEqual(err.data.opens_at, MAINNET_LAUNCH_TS)
      return true
    })
    assert.strictEqual(built, 0)
  })

  it('refuses an alias of a non-validator action (TRANSFER)', async () => {
    setup('bitcoin-mainnet')
    await assert.rejects(controller.create_tx(params('TRANSFER|0|JDOG|1|' + address)), isPrelaunch)
  })

  it('builds a non-validator action at and after launch', async () => {
    setup('bitcoin-mainnet', AT)
    await send()
    assert.strictEqual(built, 1)
  })

  it('never refuses a testnet encoder', async () => {
    setup('bitcoin-testnet')
    await send()
    assert.strictEqual(built, 1)
  })
})

describe('mainnet prelaunch validator actions', () => {
  isolateClockAndEnv()

  for (const name of ['STAKE', 'UNSTAKE', 'DELEGATE', 'SLASH', 'NODEPROOF', 'ROLLCALL']) {
    it(`lets ${name} through before launch`, async () => {
      setup('bitcoin-mainnet')
      let refusal = null
      try { await controller.create_tx(params(name + '|x')) } catch (err) { refusal = err }
      // Either the stub build ran, or a later param check spoke; never the prelaunch gate.
      assert.ok(built === 1 || (refusal && !(refusal.data && isPrelaunch(refusal))))
    })
  }
})

describe('mainnet prelaunch operator override', () => {
  isolateClockAndEnv()

  for (const value of ['1', 'true', 'YES', 'on']) {
    it(`${ENV}=${value} lifts the refusal`, async () => {
      setup('bitcoin-mainnet')
      process.env[ENV] = value
      await send()
      assert.strictEqual(built, 1)
    })
  }

  it('is read live: unsetting it restores the refusal on the same controller', async () => {
    setup('bitcoin-mainnet')
    process.env[ENV] = '1'
    await send()
    delete process.env[ENV]
    await assert.rejects(send(), isPrelaunch)
  })

  for (const value of ['0', 'false', '', 'maybe']) {
    it(`${ENV}=${JSON.stringify(value)} leaves the refusal in force`, async () => {
      setup('bitcoin-mainnet')
      process.env[ENV] = value
      await assert.rejects(send(), isPrelaunch)
    })
  }
})
