// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The JSON-RPC entry points refuse a coin node on the wrong network tier before any build work.
// (A caller-supplied feePerKb skips the fee lookup, so only an entry gate can catch it.)

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')
const { assertNodeTier } = require('../../../src/build/blockchain_connector/node_queries')
const { TXID_A, PUBKEY_BUF, makeEncoder, getTestAddress } = require('../../integration/helpers/utxoFactory')
const actions = require('../../integration/helpers/actionFactory')

const NETWORK = 'bitcoin-testnet'
const address = getTestAddress(NETWORK)

// A testnet encoder whose stubbed node reports `chain`, with the real tier gate and build-entry counters.
function testnetEncoderOn (chain) {
  const encoder = makeEncoder(NETWORK)
  const entered = []
  encoder.connector.consensusNetwork = 'testnet'
  encoder.connector.chainName = async () => chain
  encoder.connector.assertNodeTier = assertNodeTier
  encoder.connector.getFeePerKilobyte = async () => { entered.push('fee'); return 0.00001 }
  encoder.connector.sendRawTransaction = async () => { entered.push('broadcast'); return 'ab'.repeat(32) }
  const build = encoder.createTransaction.bind(encoder)
  encoder.createTransaction = (...a) => { entered.push('build'); return build(...a) }
  const cancel = encoder.createEnvelopeCancelTransaction.bind(encoder)
  encoder.createEnvelopeCancelTransaction = (...a) => { entered.push('cancel'); return cancel(...a) }
  return { encoder, entered }
}

function sendParams () {
  return { pubkey: address, data: actions.makeSend().data, change: address, unconfirmed: true, feePerKb: 5000 }
}

function rawTxHex () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 1), 0)
  tx.addOutput(Buffer.from([bitcoin.opcodes.OP_RETURN]), 0)
  return tx.toHex()
}

const CALLS = {
  create_tx: () => sendParams(),
  create_envelope_cancel_tx: () => ({
    commitTxid: TXID_A, commitVout: 0, commitValue: 100000,
    internalPubkey: PUBKEY_BUF.toString('hex'), tapleafHash: 'c'.repeat(64), destination: address
  }),
  estimate_fee: () => undefined,
  broadcast_tx: () => ({ tx_hex: rawTxHex() }),
}

describe('JSON-RPC node tier gate', () => {
  for (const [method, params] of Object.entries(CALLS)) {
    it(`${method} refuses a mainnet node under a testnet encoder as -32010 NODE_CHAIN_MISMATCH`, async () => {
      const { encoder, entered } = testnetEncoderOn('main')
      const controller = createJsonRpcController({ encoder, NETWORK })
      await assert.rejects(controller[method](params()), (err) => {
        assert.strictEqual(err.code, -32010, err.message)
        assert.strictEqual(err.data.reason, 'NODE_CHAIN_MISMATCH')
        return true
      })
      assert.deepStrictEqual(entered, [], `${method} reached ${entered.join(',')} before the gate refused`)
    })
  }

  it('create_tx with a caller-supplied feePerKb still builds on a matching testnet node', async () => {
    const { encoder, entered } = testnetEncoderOn('testnet4')
    const controller = createJsonRpcController({ encoder, NETWORK })
    const result = await controller.create_tx(sendParams())
    assert.strictEqual(typeof result.psbt, 'string')
    assert.ok(entered.includes('build'))
  })
})
