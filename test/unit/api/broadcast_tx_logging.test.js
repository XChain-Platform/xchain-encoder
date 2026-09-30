'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

function rawTransaction () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 1), 0)
  tx.addOutput(Buffer.from([bitcoin.opcodes.OP_RETURN]), 0)
  return tx
}

describe('broadcast_tx rejection logging', function () {
  it('logs the locally derived txid without logging raw transaction hex', async function () {
    const tx = rawTransaction()
    const txHex = tx.toHex()
    const txid = tx.getId()
    const encoder = {
      connector: {
        sendRawTransaction: async () => { throw new Error('66: insufficient priority') }
      }
    }
    const controller = createJsonRpcController({ encoder, NETWORK: 'dogecoin-testnet' })
    const originalError = console.error
    const lines = []
    console.error = (line) => { lines.push(String(line)) }
    try {
      await assert.rejects(controller.broadcast_tx({ tx_hex: txHex }), /insufficient priority/)
    } finally {
      console.error = originalError
    }

    assert.strictEqual(lines.length, 1)
    assert.match(lines[0], new RegExp(`Broadcast error for txid ${txid}:`))
    assert.ok(!lines[0].includes(txHex), 'rejection log must not contain raw transaction hex')
  })
})
