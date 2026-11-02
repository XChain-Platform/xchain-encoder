// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A caller-supplied UTXO whose txid the coin node does not know (RPC -5) is a
// caller fault: create_tx answers -32010 PREV_TX_NOT_FOUND naming the txid, never
// -32603, and logs no error-level "Encoder error" line. The node is stubbed at the
// axios layer so the real connector maps both the HTTP 200 and HTTP 500 shapes.

const assert = require('assert')
const axios = require('axios')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')
const BlockchainConnector = require('../../../src/build/blockchain_connector')
const { logger } = require('../../../src/build/blockchain_connector/constants')
const { makeEncoder, makeUtxo, getTestAddress, TXID_A } = require('../../integration/helpers/utxoFactory')
const actions = require('../../integration/helpers/actionFactory')

const NETWORK = 'bitcoin-regtest'
const address = getTestAddress(NETWORK)
const FAKE_TXID = 'cd'.repeat(32)
// Legacy script: its previous transaction is always fetched, even without attachPrevTx.
const P2PKH = '76a914' + '11'.repeat(20) + '88ac'
const NOT_FOUND = { result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' } }

const NODE_SHAPES = {
  'HTTP 200 error body': (txids, real) => async (url, data) => {
    const txid = data.params[0]
    return txid === FAKE_TXID ? { data: NOT_FOUND } : { data: { result: { hex: real.get(txid) } } }
  },
  'HTTP 500 error.response body': (txids, real) => async (url, data) => {
    const txid = data.params[0]
    if (txid !== FAKE_TXID) return { data: { result: { hex: real.get(txid) } } }
    throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: NOT_FOUND } })
  }
}

function paramsFor (utxos, attachPrevTx) {
  return {
    utxos, pubkey: address, customOutputs: [], data: actions.makeSend().data,
    change: address, unconfirmed: false, attachPrevTx, options: { exactInputs: true }
  }
}

describe('create_tx with a UTXO txid the node does not know', () => {
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

  for (const [shape, makePost] of Object.entries(NODE_SHAPES)) {
    const cases = {
      'a fake-only UTXO': (real) => [{ txid: FAKE_TXID, vout: 0, value: 100000, scriptPubKey: P2PKH, confirmations: 6 }],
      'a real UTXO followed by a fake one': (real) => [real.utxo, { txid: FAKE_TXID, vout: 0, value: 100000, scriptPubKey: P2PKH, confirmations: 6 }]
    }
    for (const [label, makeUtxos] of Object.entries(cases)) {
      for (const attach of [false, true]) {
        it(`${shape}, ${label} (attachPrevTx ${attach}): -32010 PREV_TX_NOT_FOUND, no Encoder error log`, async () => {
          const encoder = makeEncoder(NETWORK)
          const realUtxo = makeUtxo(NETWORK, TXID_A, 0, 100000000)
          const hexes = new Map()
          // Serve the real funding tx from the stub encoder's own prev-tx fixture.
          hexes.set(TXID_A, await encoder.connector.getTransactionHex(TXID_A))
          axios.post = makePost(null, hexes)
          encoder.connector.getTransactionHex = BlockchainConnector.prototype.getTransactionHex
            .bind({ url: 'http://127.0.0.1:1', rpcUser: 'u', rpcPassword: 'p' })
          const controller = createJsonRpcController({ encoder, NETWORK })
          const utxos = makeUtxos({ utxo: realUtxo })
          let caught
          try { await controller.create_tx(paramsFor(utxos, attach)) } catch (e) { caught = e }
          assert.ok(caught, 'create_tx should reject')
          assert.strictEqual(caught.code, -32010, `code ${caught.code}: ${caught.message}`)
          assert.strictEqual(caught.data.reason, 'PREV_TX_NOT_FOUND')
          assert.ok(caught.message.includes(FAKE_TXID), caught.message)
          assert.deepStrictEqual(errorLines.filter(l => /Encoder error/.test(l)), [])
        })
      }
    }
  }
})
