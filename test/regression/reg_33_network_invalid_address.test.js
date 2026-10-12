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
// A well-formed address that does not decode on the encoder's network is a
// caller fault: -32602, named by field, refused before any tracker or fee work.

const assert = require('assert')
const { createJsonRpcController } = require('../../src/api/json_rpc_methods')
const { assertAddressOnNetwork } = require('../../src/XChainEncoder/request_resolution')
const CryptoNetworks = require('../../src/build/crypto_networks')
const { TXID_A, PUBKEY_BUF, makeEncoder, getTestAddress } = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'bitcoin-regtest'
const REGTEST = CryptoNetworks.getBitcoinJsNetwork(NETWORK)
const address = getTestAddress(NETWORK)
const MAINNET_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
const REGTEST_P2TR = 'bcrt1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqc8gma6'
// Flip the last character so the base58 checksum no longer matches.
const BAD_CHECKSUM = address.slice(0, -1) + (address.endsWith('A') ? 'B' : 'A')

// Count every tracker fetch and node fee read, so a test can prove none ran.
function recordUpstream (encoder, calls) {
  const tracker = encoder.utxoTrackerConnector.getUtxosFromAddress
  const fee = encoder.connector.getFeePerKilobyte
  const info = encoder.connector.getNetworkInfo
  encoder.utxoTrackerConnector.getUtxosFromAddress = (...a) => { calls.push('tracker'); return tracker(...a) }
  encoder.connector.getFeePerKilobyte = (...a) => { calls.push('fee'); return fee(...a) }
  encoder.connector.getNetworkInfo = (...a) => { calls.push('networkinfo'); return info(...a) }
}

// Run one JSON-RPC method against a fresh stubbed encoder; return its outcome and upstream calls.
async function run (method, params) {
  const encoder = makeEncoder(NETWORK)
  const calls = []
  recordUpstream(encoder, calls)
  const controller = createJsonRpcController({ encoder, NETWORK })
  try {
    return { result: await controller[method](params), calls }
  } catch (caught) {
    return { caught, calls }
  }
}

function sendParams (extra) {
  return Object.assign({ pubkey: address, data: actions.makeSend().data, change: address, unconfirmed: true }, extra)
}

function cancelParams (destination) {
  return {
    commitTxid: TXID_A, commitVout: 0, commitValue: 100000,
    internalPubkey: PUBKEY_BUF.toString('hex'), tapleafHash: 'c'.repeat(64), destination
  }
}

// Assert a -32602 naming the field, with no tracker or node fee work done first.
function assertCallerFault (outcome, field) {
  assert.ok(outcome.caught, 'the request should have been refused')
  assert.strictEqual(outcome.caught.code, -32602, outcome.caught.message)
  assert.ok(outcome.caught.message.includes(field), outcome.caught.message)
  assert.deepStrictEqual(outcome.calls, [], 'refused only after upstream work: ' + outcome.calls.join(','))
}

describe('REG-33: create_tx refuses a network-invalid address as a caller fault', () => {
  it('a mainnet customOutputs address on regtest', async () => {
    assertCallerFault(await run('create_tx', sendParams({ customOutputs: [{ address: MAINNET_P2PKH, value: 10000 }] })),
      'customOutputs[0].address')
  })

  it('a mainnet feeQuote address on regtest', async () => {
    assertCallerFault(await run('create_tx', sendParams({ feeQuote: { address: MAINNET_P2PKH, amount: 1000 } })),
      'feeQuote.address')
  })

  it('a change address with a bad checksum', async () => {
    assertCallerFault(await run('create_tx', sendParams({ change: BAD_CHECKSUM })), 'change')
  })

  it('a P2SH funding call, where the custom output is only priced and never emitted', async () => {
    assertCallerFault(await run('create_tx', sendParams({
      encoding: 'P2SH', customOutputs: [{ address: MAINNET_P2PKH, value: 10000 }]
    })), 'customOutputs[0].address')
  })
})

describe('REG-33: create_envelope_cancel_tx refuses a network-invalid destination', () => {
  it('a mainnet destination on regtest', async () => {
    assertCallerFault(await run('create_envelope_cancel_tx', cancelParams(MAINNET_P2PKH)), 'destination')
  })
})

describe('REG-33: valid addresses still build', () => {
  it('a regtest Taproot custom output on a default create_tx', async () => {
    const outcome = await run('create_tx', sendParams({ customOutputs: [{ address: REGTEST_P2TR, value: 10000 }] }))
    assert.ok(!outcome.caught, outcome.caught && outcome.caught.message)
  })

  it('assertAddressOnNetwork accepts regtest P2PKH and P2TR and labels a refusal', () => {
    assert.strictEqual(assertAddressOnNetwork(address, REGTEST, 'x'), address)
    assert.strictEqual(assertAddressOnNetwork(REGTEST_P2TR, REGTEST, 'x'), REGTEST_P2TR)
    assert.throws(() => assertAddressOnNetwork(MAINNET_P2PKH, REGTEST, 'payTo'),
      (err) => err instanceof TypeError && /payTo is not a valid address for this network/.test(err.message))
    assert.throws(() => assertAddressOnNetwork('', REGTEST, 'payTo'),
      (err) => err instanceof TypeError && /payTo must be a non-empty string/.test(err.message))
  })
})
