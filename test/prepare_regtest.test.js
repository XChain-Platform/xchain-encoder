/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict'

process.env.DOTENV_CONFIG_PATH = '/dev/null'

const { execFileSync } = require('child_process')
const { rmSync } = require('fs')
const { homedir } = require('os')
const path = require('path')
const nodeHelper = require('./helpers/node_helper')
const { waitFor } = require('./helpers/timing')

const RESET_OPT_IN = 'XCHAIN_RESET_REGTEST'

function executeCommand (command, args) {
  return execFileSync(command, args, { stdio: 'pipe' })
}

function checkNode () {
  try {
    const networkInfo = executeCommand('bitcoin-cli', ['-regtest', 'getnetworkinfo'])
    return JSON.parse(networkInfo).networkactive === true
  } catch (error) {
    return false
  }
}

exports.mochaHooks = {
  async beforeAll () {
    if (process.env[RESET_OPT_IN] !== '1') {
      console.log(`Skipping regtest reset; set ${RESET_OPT_IN}=1 to opt in`)
      return
    }

    if (checkNode()) {
      console.log('Stopping node')
      executeCommand('bitcoin-cli', ['-regtest', 'stop'])
    } else {
      console.log('The node is not working, continuing execution')
    }

    console.log('Cleaning node')
    rmSync(path.join(homedir(), '.bitcoin', 'regtest'), {
      force: true,
      recursive: true
    })

    console.log('Restarting node')
    executeCommand('bitcoind', [
      '-regtest',
      '-daemon',
      '-fallbackfee=1.0',
      '-maxtxfee=1.1'
    ])

    console.log('Checking node')
    await waitFor(() => checkNode(), {
      timeout: 60000,
      interval: 1000,
      message: 'regtest bitcoind did not become ready'
    })

    console.log('Regtest node reset and ready')
    console.log("Creating the wallet 'test-wallet'")
    const nodeClientTest = await nodeHelper.getWalletConnection('test-wallet')

    console.log('Obtaining an address')
    global.mainTestAddress = await nodeClientTest.getNewAddress()
    console.log(`The address obtained is ${global.mainTestAddress}. Generating blocks.`)
    await nodeClientTest.generateToAddress(101, global.mainTestAddress)
    console.log('Obtaining balance')
    const balance = await nodeClientTest.getBalance()
    console.log(`The address ${global.mainTestAddress} has ${balance} BTC`)
  }
}
