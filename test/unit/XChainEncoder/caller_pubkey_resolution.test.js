// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The caller pubkey is refused as caller input (-32602) when it is off the curve
// or resolves to no address, on the validator, both resolvers and the build.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const secp = require('tiny-secp256k1')
const v = require('../../../src/common/validator.js')
const { resolveCallerHash160, resolveCallerAddress } = require('../../../src/XChainEncoder/request_resolution.js')
const { TXID_A, PUBKEY_BUF, makeUtxo, makeEncoder, getTestAddress } = require('../../integration/helpers/utxoFactory')
const actions = require('../../integration/helpers/actionFactory')
const { createJsonRpcController } = require('../../../src/api/json_rpc_methods')

// x = 5 has no secp256k1 point; the shape regexes and bitcoinjs both accept it.
const OFF_CURVE = '02' + '0'.repeat(63) + '5'
const ON_CURVE = PUBKEY_BUF.toString('hex')
const DOGE = 'dogecoin-regtest'

function isCallerInput (pattern) {
  return (err) => err instanceof TypeError && err.invalidParams === true && pattern.test(err.message)
}

describe('caller pubkey: curve check and caller-input refusals', () => {
  it('uses a fixture key that really is off the curve and passes the shape checks', () => {
    assert.strictEqual(secp.isPoint(Buffer.from(OFF_CURVE, 'hex')), false)
    assert.strictEqual(secp.isPoint(PUBKEY_BUF), true)
    assert.ok(/^(02|03)[0-9a-fA-F]{64}$/.test(OFF_CURVE))
  })

  it('validatePubkey refuses an off-curve compressed key and keeps a real one', () => {
    assert.throws(() => v.validatePubkey(OFF_CURVE), isCallerInput(/pubkey is not a valid secp256k1 point/))
    assert.strictEqual(v.validatePubkey(ON_CURVE), ON_CURVE)
  })

  it('resolveCallerHash160 refuses an off-curve key instead of hashing it into the chunk gate', () => {
    assert.throws(() => resolveCallerHash160(OFF_CURVE), isCallerInput(/not a valid secp256k1 point/))
    assert.deepStrictEqual(resolveCallerHash160(ON_CURVE), bitcoin.crypto.hash160(PUBKEY_BUF))
  })

  it('resolveCallerHash160 types an unresolvable identity as caller input', () => {
    assert.throws(() => resolveCallerHash160('deadbeefdeadbeef'), isCallerInput(/cannot resolve a 20-byte caller HASH160/))
  })

  it('resolveCallerAddress refuses an off-curve key and an unresolvable identity', () => {
    const network = bitcoin.networks.regtest
    assert.throws(() => resolveCallerAddress(OFF_CURVE, network), isCallerInput(/not a valid secp256k1 point/))
    assert.throws(() => resolveCallerAddress('deadbeefdeadbeef', network), isCallerInput(/pubkey is neither a valid address/))
  })

  it('resolveCallerAddress still passes an on-network address through, Taproot included', () => {
    const network = bitcoin.networks.regtest
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: PUBKEY_BUF, network }).address
    const p2tr = bitcoin.address.toBech32(Buffer.alloc(32, 1), 1, network.bech32)
    assert.strictEqual(resolveCallerAddress(p2wpkh, network), p2wpkh)
    assert.strictEqual(resolveCallerAddress(p2tr, network), p2tr)
    assert.strictEqual(resolveCallerAddress(ON_CURVE, network), p2wpkh)
  })

  it('a P2SH build with an off-curve pubkey and caller utxos is refused before any output is built', async () => {
    const encoder = makeEncoder(DOGE)
    await assert.rejects(
      () => encoder.createTransaction(
        [makeUtxo(DOGE, TXID_A, 0, 100000000)], OFF_CURVE, null,
        actions.makeIssueFull().data, null, 10000, false, null, getTestAddress(DOGE),
        null, null, null, true, 0.00001
      ),
      isCallerInput(/not a valid secp256k1 point/)
    )
  })
})

describe('caller pubkey: the tracker lane answers an unresolvable identity with -32602', () => {
  const NETWORK = 'bitcoin-regtest'
  const address = getTestAddress(NETWORK)

  // Run create_tx with no caller utxos, so the build fetches from the tracker.
  async function createTx (pubkey) {
    const encoder = makeEncoder(NETWORK)
    const trackerCalls = []
    const fetch = encoder.utxoTrackerConnector.getUtxosFromAddress
    encoder.utxoTrackerConnector.getUtxosFromAddress = (...a) => { trackerCalls.push(a[0]); return fetch(...a) }
    const controller = createJsonRpcController({ encoder, NETWORK })
    const params = { pubkey, data: actions.makeSend().data, change: address, unconfirmed: true }
    try {
      return { result: await controller.create_tx(params), trackerCalls }
    } catch (caught) {
      return { caught, trackerCalls }
    }
  }

  function assertPubkeyFault (outcome) {
    assert.ok(outcome.caught, 'the request should have been refused')
    assert.strictEqual(outcome.caught.code, -32602, outcome.caught.message)
    assert.ok(outcome.caught.message.includes('pubkey'), outcome.caught.message)
    assert.deepStrictEqual(outcome.trackerCalls, [], 'the tracker was asked for an unresolvable identity')
  }

  it('a hex string that is no pubkey and no address', async () => {
    assertPubkeyFault(await createTx('deadbeefdeadbeef'))
  })

  it('a mainnet address on regtest', async () => {
    assertPubkeyFault(await createTx('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'))
  })

  it('a regtest address and a compressed pubkey hex still reach the tracker and build', async () => {
    for (const pubkey of [address, ON_CURVE]) {
      const outcome = await createTx(pubkey)
      assert.ok(!outcome.caught, outcome.caught && outcome.caught.message)
      assert.strictEqual(outcome.trackerCalls.length, 1)
    }
  })
})
