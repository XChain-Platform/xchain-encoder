/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const { execSync } = require('child_process');
const nodeHelper = require('./nodeHelper')

// Función para ejecutar comandos del sistema
function executeCommand(comando) {
  let options = {stdio : 'pipe' };
  return execSync(comando, options);
}

function checkNode(){
  try {
    // Obtener la información de la red utilizando bitcoin-cli
    const networkInfo = executeCommand('bitcoin-cli -regtest getnetworkinfo');

	// Analizar la salida para verificar si el nodo regtest está en ejecución
    const parsedNetworkInfo = JSON.parse(networkInfo);
    return parsedNetworkInfo.networkactive === true;
  } catch (error) {
    // Manejar errores si es necesario
	return false
  }
}

// Función para esperar un tiempo específico
function wait(ms) {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

exports.mochaHooks = {
   async beforeAll(){
	 if (checkNode()){
	   // Stop regtest node
       console.log("Stopping node")
       executeCommand('bitcoin-cli -regtest stop');
	 } else {
	   console.log("The node is not working, continuing execution")
	   //Assuming regtest node is not executing
	 }

     // Limpiar la cadena de bloques y los datos del nodo regtest (opcional)
	 console.log("Cleaning node")
     executeCommand('rm -rf ~/.bitcoin/regtest');

     // Inicializar el nodo regtest
     console.log("Restarting node")
     executeCommand('bitcoind -regtest -daemon -fallbackfee=1.0 -maxtxfee=1.1');

     console.log("Checking node")
	 await wait(1000)
     while (!checkNode()){
		 console.log("Node is not ready yet, waiting 5 seconds")
		 await wait(5000)
	 }

    // Puedes realizar más acciones después de reiniciar el nodo si es necesario
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
