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

const { execSync } = require('child_process');
const nodeHelper = require('./nodeHelper')
const { waitFor } = require('./helpers/timing')

function executeCommand(comando) {
  let options = {stdio : 'pipe' };
  return execSync(comando, options);
}

function checkNode(){
  try {
    const networkInfo = executeCommand('bitcoin-cli -regtest getnetworkinfo');

    const parsedNetworkInfo = JSON.parse(networkInfo);
    return parsedNetworkInfo.networkactive === true;
  } catch (error) {
	return false
  }
}

exports.mochaHooks = {
   async beforeAll(){
	 if (checkNode()){
       console.log("Stopping node")
       executeCommand('bitcoin-cli -regtest stop');
	 } else {
	   console.log("The node is not working, continuing execution")
	 }

	 console.log("Cleaning node")
     executeCommand('rm -rf ~/.bitcoin/regtest');

     console.log("Restarting node")
     executeCommand('bitcoind -regtest -daemon -fallbackfee=1.0 -maxtxfee=1.1');

     console.log("Checking node")
     // Condition-wait on daemon readiness instead of a fixed sleep loop:
     // returns as soon as getnetworkinfo succeeds, and throws (failing the
     // run loudly) if the node never comes up within the deadline.
     await waitFor(() => checkNode(), {
       timeout: 60000,
       interval: 1000,
       message: 'regtest bitcoind did not become ready'
     })

    console.log('Nodo regtest reset and ready.');
	
	console.log("Creating the wallet 'test-wallet'")
	nodeClientTest = await nodeHelper.getWalletConnection('test-wallet') 
	
	console.log("Obtaining an address")
	global.mainTestAddress = await nodeClientTest.getNewAddress()
	console.log("The address obtained is "+mainTestAddress+". Generating blocks.")
	await nodeClientTest.generateToAddress(101, mainTestAddress)
	console.log("Obtaining balance")
	let balance = await nodeClientTest.getBalance()
	console.log("The address "+mainTestAddress+" has "+balance+" BTC")
	
  }
}
