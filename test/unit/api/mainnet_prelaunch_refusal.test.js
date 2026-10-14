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
const { MAINNET_LAUNCH_TS, assertNotMainnetPrelaunch } = require('../../../src/common/config')
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

// The validator wire set by name and format, the set consensus admits on mainnet before launch.
const ADMITTED = ['ANCHOR|0', 'ANCHOR|1', 'ANCHOR|2', 'ANCHOR|3', 'PRICE|0', 'NODEPROOF|0',
  'ROLLCALL|0', 'ROLLCALL|1', 'ATTEST|1', 'ATTEST|3', 'ATTEST|4', 'ATTEST|5', 'ATTEST|6']
// User actions consensus skips before launch, including the user formats that share a validator name.
const REFUSED = ['PRICE|1', 'ATTEST|0', 'ATTEST|2', 'ANCHOR|4', 'STAKE|0', 'UNSTAKE|0', 'DELEGATE|0', 'SLASH|0']

describe('mainnet prelaunch validator actions', () => {
  isolateClockAndEnv()

  for (const head of ADMITTED) {
    it(`lets ${head} through before launch`, async () => {
      setup('bitcoin-mainnet')
      await controller.create_tx(params(head + '|x'))
      assert.strictEqual(built, 1)
    })
  }

  it('reads the name the way consensus does: trimmed and upper-cased, format optional, Buffer decoded', () => {
    const guard = (data) => assertNotMainnetPrelaunch({ consensusNetwork: 'mainnet' }, { data }, () => BEFORE)
    for (const data of [' anchor |0|x', 'NODEPROOF', 'PRICE|"0"|x', Buffer.from('ATTEST|5|x')]) {
      assert.doesNotThrow(() => guard(data), `refused ${data}`)
    }
    for (const data of ['PRICE|01x', 'ATTEST|5.0', 'ANCHOR|256', null, '']) {
      assert.throws(() => guard(data), isPrelaunch, `admitted ${data}`)
    }
  })
})

describe('mainnet prelaunch user actions sharing or missing the validator set', () => {
  isolateClockAndEnv()

  for (const head of REFUSED) {
    it(`refuses ${head} before launch`, async () => {
      setup('bitcoin-mainnet')
      await assert.rejects(controller.create_tx(params(head + '|x')), isPrelaunch)
      assert.strictEqual(built, 0)
    })
  }

  it('builds a user format of a validator name at launch', async () => {
    setup('bitcoin-mainnet', AT)
    await controller.create_tx(params('PRICE|1|x'))
    assert.strictEqual(built, 1)
  })
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
