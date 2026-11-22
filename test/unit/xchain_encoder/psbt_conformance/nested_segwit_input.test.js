// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Treat P2SH-P2WPKH as a segwit spend with witnessUtxo and its P2WPKH redeemScript.
// It costs about 91 vbytes, versus 299 for worst-case legacy 2-of-3 multisig.
// Derive the redeem script from the request key; without one the input stays legacy.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bs58check = require('bs58check').default
const { ECPair, PRIVATE_KEY, PUBKEY, PUBKEY_HEX, networkOf, paymentFor, utxoFor, makeEncoder, build, feeOf } =
  require('../../../helpers/psbt_build_fixtures.js')

const BTC = 'bitcoin-regtest'
const FEE_PER_KB = 2000
const bip32 = BIP32Factory(ecc)
const SIGNED_TX_VECTOR = [
  '0200000000010294fc28443bb36955a9c8f05de48599946db568ee541560d4fdfadd4d16409dd30000000017160014751e76e8199196d454941c45d1b3a323f1433bd6ffffffff',
  '12f6f7990ed149b950c04dc3023d2850d7dfe17aaede2f1c62805d1c33b3d9490000000017160014751e76e8199196d454941c45d1b3a323f1433bd6ffffffff',
  '030000000000000000156a13ed0b525634dcbad27714cba02932cb2a711a5fe0c8100000000000160014751e76e8199196d454941c45d1b3a323f1433bd6d60a03000000000017a914bcfeb728b584253d5f3f70bcb780e9ef218a68f487',
  '02483045022100cc2c04e0a43fd5e8c6d7096d592ba1c1edacb80fff9bf4bf22336fb7e9e4bc510220679bbdd45433fe8c0a3f2ea7c9bd2232b18c9d2e806b1c676fa0e887840700ce01210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  '02483045022100f7d186d9b88bbc57b34ab39a2f75eb9bfea0a03995f55aaf39cc8c0df55d399602201a656718a8cbdc190a8c591ccaeacd38d41e579cce471db5bc152747f639a94301210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179800000000'
].join('')

async function nestedBuild (request) {
  const prevTxs = new Map()
  const nested = paymentFor('p2sh-p2wpkh', BTC)
  const encoder = makeEncoder(BTC, { estimate: 0.00002, relayfee: 0.00001, prevTxs })
  const res = await build(encoder, Object.assign({
    utxos: [utxoFor(prevTxs, nested.output, 1000000, 'nested'), utxoFor(prevTxs, nested.output, 300000, 'nested2')],
    data: 'BROADCAST|0|hi', encoding: 'OP_RETURN', change: nested.address, feePerKb: FEE_PER_KB,
    customOutputs: [{ address: paymentFor('p2wpkh', BTC).address, value: 1100000 }]
  }, request))
  return { res, nested }
}

describe('XChainEncoder P2SH-P2WPKH funding inputs', function () {
  it('builds each input with witnessUtxo and the key\'s P2WPKH redeemScript', async function () {
    const { res, nested } = await nestedBuild({ pubkey: PUBKEY_HEX })
    for (const input of res.psbt.data.inputs) {
      assert.ok(input.witnessUtxo, 'witnessUtxo carries the value a segwit sighash commits to')
      assert.ok(input.redeemScript && input.redeemScript.equals(nested.redeem.output))
    }
    const derived = bip32.fromSeed(
      Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), networkOf(BTC)
    ).derivePath("m/0'/1/2'/2/1000000000")
    assert.strictEqual(derived.toBase58(),
      'tprv8kgvuL81tmn36Fv9z38j8f4K5m1HGZRjZY2QxnXDy5PuqbP6a5TzoKWCgTcGHBu66W3TgSbAu2yX6sPza5FkHmy564Sh6gmCPUNeUt4yj2x')
    const address = bitcoin.payments.p2pkh({ pubkey: derived.publicKey, network: networkOf(BTC) }).address
    assert.strictEqual(address, 'n15g8utnqJhfqxKtj3JwDtQ9L5mBJWu4iF')
    assert.strictEqual(Buffer.from(bs58check.decode(address)).toString('hex'),
      '6fd69aa102255fed74378278c7812701ea641fdf32')
  })

  it('prices the inputs at their signed size, so the fee lands at the requested rate', async function () {
    const { res } = await nestedBuild({ pubkey: PUBKEY_HEX })
    const psbt = bitcoin.Psbt.fromHex(res.psbt.toHex(), { network: networkOf(BTC) })
    psbt.signAllInputs(ECPair.fromPrivateKey(PRIVATE_KEY))
    psbt.finalizeAllInputs()
    const signedTx = psbt.extractTransaction(true)
    assert.strictEqual(signedTx.toHex(), SIGNED_TX_VECTOR)
    const vsize = signedTx.virtualSize()
    const rate = Number(feeOf(res.psbt)) / vsize
    assert.ok(rate >= FEE_PER_KB / 1000 && rate < 1.25 * FEE_PER_KB / 1000, `fee rate ${rate} per vbyte`)
  })

  it('takes the key from compressedPubKey when pubkey is the P2SH address', async function () {
    const nested = paymentFor('p2sh-p2wpkh', BTC)
    const { res } = await nestedBuild({ pubkey: nested.address, compressedPubKey: PUBKEY_HEX })
    assert.ok(res.psbt.data.inputs.every(input => input.redeemScript && input.witnessUtxo))
  })

  it('builds a P2SH address given with no public key as a legacy input', async function () {
    const nested = paymentFor('p2sh-p2wpkh', BTC)
    const { res } = await nestedBuild({ pubkey: nested.address })
    assert.ok(res.psbt.data.inputs.every(input => input.nonWitnessUtxo && !input.witnessUtxo && !input.redeemScript))
  })

  it('leaves a P2SH input the key does not match as a legacy input', async function () {
    const prevTxs = new Map()
    const net = networkOf(BTC)
    const other = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2ms({ m: 1, pubkeys: [PUBKEY], network: net }), network: net })
    const pay = paymentFor('p2wpkh', BTC)
    const res = await build(makeEncoder(BTC, { estimate: 0.00002, relayfee: 0.00001, prevTxs }), {
      utxos: [utxoFor(prevTxs, other.output, 1000000, 'legacy-p2sh')], pubkey: PUBKEY_HEX,
      data: 'BROADCAST|0|hi', encoding: 'OP_RETURN', change: pay.address, feePerKb: FEE_PER_KB
    })
    const input = res.psbt.data.inputs[0]
    assert.ok(input.nonWitnessUtxo && !input.witnessUtxo && !input.redeemScript)
  })
})
