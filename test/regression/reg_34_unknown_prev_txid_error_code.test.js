// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Pins that create_tx naming an outpoint whose previous transaction the coin
// node does not know (RPC -5) is a caller fault: -32010 with a stable reason,
// never -32603, and no error-level "Encoder error" log line. The node is stubbed
// at the axios layer so the real connector maps both the HTTP 200 and the
// HTTP 500 (LTC/DOGE) shapes of the -5 answer.

const assert = require('assert')
const axios = require('axios')
const { createJsonRpcController } = require('../../src/api/json_rpc_methods')
const { makeEncoder, getTestAddress } = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')
const BlockchainConnector = require('../../src/build/blockchain_connector')
const { logger } = require('../../src/build/blockchain_connector/constants')

const NETWORK = 'bitcoin-regtest'
const address = getTestAddress(NETWORK)
const FAKE_TXID = 'ab'.repeat(32)
const P2PKH = '76a914' + '11'.repeat(20) + '88ac'

function params (attachPrevTx) {
  return {
    utxos: [{ txid: FAKE_TXID, vout: 0, value: 100000, scriptPubKey: P2PKH, confirmations: 6 }],
    pubkey: address,
    customOutputs: [],
    data: actions.makeSend().data,
    change: address,
    unconfirmed: false,
    attachPrevTx,
    options: { exactInputs: true }
  }
}

const NODE_ANSWERS = {
  'HTTP 200 body': async () => ({ data: { result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' } } }),
  'HTTP 500 body': async () => {
    throw Object.assign(new Error('Request failed with status code 500'), {
      response: { status: 500, data: { result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' } } }
    })
  }
}

describe('REG-34: create_tx with a prev txid the node does not know', () => {
  let originalPost, originalError, errorLines
  beforeEach(() => {
    originalPost = axios.post
    originalError = logger.error
    errorLines = []
    logger.error = (...args) => { errorLines.push(args.join(' ')) }
  })
  afterEach(() => {
    axios.post = originalPost
    logger.error = originalError
  })

  for (const [shape, answer] of Object.entries(NODE_ANSWERS)) {
    for (const attach of [false, true]) {
      it(`answers -32010, never -32603, for a ${shape} (attachPrevTx ${attach})`, async () => {
        axios.post = answer
        const encoder = makeEncoder(NETWORK)
        // Use the real connector method; keep the other stubbed node queries.
        encoder.connector.getTransactionHex = BlockchainConnector.prototype.getTransactionHex.bind({ url: 'http://127.0.0.1:1', rpcUser: 'u', rpcPassword: 'p' })
        const controller = createJsonRpcController({ encoder, NETWORK })
        let caught
        try { await controller.create_tx(params(attach)) } catch (e) { caught = e }
        assert.ok(caught, 'create_tx should reject')
        assert.ok(caught.code === -32602 || caught.code === -32010, `code ${caught.code}: ${caught.message}`)
        assert.notStrictEqual(caught.message, 'Internal encoder error')
        assert.ok(caught.message.includes(FAKE_TXID), caught.message)
        assert.deepStrictEqual(errorLines.filter(l => /Encoder error/.test(l)), [])
      })
    }
  }
})
