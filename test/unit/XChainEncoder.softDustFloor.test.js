// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Dogecoin relays an output under its 0.01 DOGE soft dust limit only if the whole
// limit is added to the fee, per output; a P2SH funding leg sized off the 0.001 hard
// limit therefore never reaches a miner. These tests pin the floor on authored outputs.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const CryptoNetworks = require('../../src/CryptoNetworks')

const SOFT_DUST_DOGE = 1000000     // 0.01 DOGE in koinu
const HARD_DUST_DOGE = 100000      // the pinned network.dustThreshold

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)

function p2pkhFor (network) {
  return bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network })
}

function makeLegacyUtxo (network, txid, vout, value) {
  return {
    txid,
    vout,
    value,
    confirmations: 6,
    scriptPubKey: p2pkhFor(network).output.toString('hex')
  }
}

function buildRawP2pkhTxHex (network, value) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  tx.addOutput(p2pkhFor(network).output, value)
  return tx.toHex()
}

// A DOGE regtest encoder whose node reports the fee rate measured live on
// testnet during the stall (0.0112 DOGE/kB), with one large confirmed input.
function makeDogeEncoder (feePerKb, dustAmount) {
  const encoder = new XChainEncoder(
    'dogecoin-regtest', '127.0.0.1', '18332', 'rpc', 'rpc', '', '',
    null, undefined, undefined, dustAmount
  )
  const network = encoder.network
  encoder.connector = {
    getFeePerKilobyte: async () => feePerKb,
    getTransactionHex: async () => buildRawP2pkhTxHex(network, 100000000000)
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [makeLegacyUtxo(network, TXID_A, 0, 100000000000)]
    })
  }
  return encoder
}

// A PRICE-batch-sized payload: ~2 KB, which the P2SH path splits into several
// funding legs, the same shape as the stalled testnet wires.
const PRICE_SIZED_PAYLOAD = 'PRICE|' + 'x'.repeat(2000)
const LIVE_STALL_FEE_PER_KB = 0.0112

async function buildDogeFunding (encoder, dust) {
  const network = encoder.network
  const address = p2pkhFor(network).address
  const utxo = makeLegacyUtxo(network, TXID_A, 0, 100000000000)
  return encoder.createTransaction(
    [utxo], address, null,
    PRICE_SIZED_PAYLOAD, null, null, false, 'P2SH', address,
    null, null, null, true, LIVE_STALL_FEE_PER_KB, dust, null, false, false
  )
}

describe('XChainEncoder soft-dust floor on authored outputs', () => {
  describe('the floor', () => {
    it('raises the DOGE floor from the pinned hard limit to the 0.01 DOGE soft limit on every network', () => {
      for (const key of ['dogecoin-regtest', 'dogecoin-testnet', 'dogecoin-mainnet']) {
        const encoder = new XChainEncoder(key, '127.0.0.1', '18332', 'rpc', 'rpc', '', '')
        assert.strictEqual(encoder.network.dustThreshold, HARD_DUST_DOGE, key + ': the pinned consensus constant is untouched')
        assert.strictEqual(encoder.dustAmount, HARD_DUST_DOGE, key + ': the fee floor stays on the pinned constant')
        assert.strictEqual(encoder.outputFloor, SOFT_DUST_DOGE, key + ': authored outputs floor at the soft limit')
      }
    })

    it('leaves BTC and LTC at their pinned dust threshold (no soft limit there)', () => {
      for (const key of ['bitcoin-regtest', 'litecoin-regtest']) {
        const encoder = new XChainEncoder(key, '127.0.0.1', '18332', 'rpc', 'rpc', '', '')
        assert.strictEqual(encoder.outputFloor, encoder.network.dustThreshold, key)
      }
    })

    it('lets an operator DUST_AMOUNT raise the floor but never lower it', () => {
      const raised = new XChainEncoder('dogecoin-regtest', '127.0.0.1', '18332', 'rpc', 'rpc', '', '', null, undefined, undefined, 2000000)
      assert.strictEqual(raised.outputFloor, 2000000)
      assert.strictEqual(raised.dustAmount, HARD_DUST_DOGE, 'the fee floor never moves with DUST_AMOUNT')
      const lowered = new XChainEncoder('dogecoin-regtest', '127.0.0.1', '18332', 'rpc', 'rpc', '', '', null, undefined, undefined, 500000)
      assert.strictEqual(lowered.outputFloor, SOFT_DUST_DOGE, 'below the soft limit is ignored')
      const garbage = new XChainEncoder('dogecoin-regtest', '127.0.0.1', '18332', 'rpc', 'rpc', '', '', null, undefined, undefined, 'nope')
      assert.strictEqual(garbage.outputFloor, SOFT_DUST_DOGE, 'unparseable is ignored')
      const btc = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '18332', 'rpc', 'rpc', '', '', null, undefined, undefined, 1000)
      assert.strictEqual(btc.outputFloor, 1000, 'BTC takes the operator floor above 546')
    })
  })

  describe('P2SH funding legs at the fee rate that stalled testnet', () => {
    it('is a discriminating rate: the per-chunk fee share alone sits under the soft limit', () => {
      // Guards the test itself: at 0.0112 DOGE/kB a chunk-sized reveal input
      // prices well under 0.01 DOGE, so only the floor can lift the legs.
      const encoder = makeDogeEncoder(LIVE_STALL_FEE_PER_KB)
      const chunk = Buffer.alloc(520, 0x78)
      const chunkFee = Math.trunc(encoder.estimateSpendingP2shTx(chunk) * (LIVE_STALL_FEE_PER_KB / 1000) * 100000000)
      assert.ok(chunkFee < SOFT_DUST_DOGE, 'chunk fee share ' + chunkFee + ' should be under the soft limit')
      assert.ok(chunkFee > HARD_DUST_DOGE, 'and over the hard limit, exactly the stalled band')
    })

    it('authors no funding leg below 0.01 DOGE', async () => {
      const encoder = makeDogeEncoder(LIVE_STALL_FEE_PER_KB)
      const funding = await buildDogeFunding(encoder, null)
      assert.strictEqual(funding.encoding, 'P2SH')
      const outs = funding.psbt.txOutputs
      assert.ok(outs.length >= 3, 'a PRICE-sized payload needs several legs, got ' + outs.length)
      for (const o of outs) {
        assert.ok(o.value >= SOFT_DUST_DOGE, 'output of ' + o.value + ' koinu is under the 0.01 DOGE soft limit')
      }
    })

    it('clamps a caller dust below the floor up to the floor', async () => {
      const encoder = makeDogeEncoder(LIVE_STALL_FEE_PER_KB)
      const funding = await buildDogeFunding(encoder, HARD_DUST_DOGE)
      for (const o of funding.psbt.txOutputs) {
        assert.ok(o.value >= SOFT_DUST_DOGE, 'caller dust=' + HARD_DUST_DOGE + ' still authored a ' + o.value + ' koinu leg')
      }
    })

    it('still lets a caller raise the floor above the soft limit', async () => {
      const encoder = makeDogeEncoder(LIVE_STALL_FEE_PER_KB)
      const funding = await buildDogeFunding(encoder, 3000000)
      for (const o of funding.psbt.txOutputs) {
        assert.ok(o.value >= 3000000, 'caller dust=3000000 authored a ' + o.value + ' koinu leg')
      }
    })
  })
})

// Keep the module-level CryptoNetworks import meaningful for readers of the
// fixtures above: every address here is derived from the coin's own params.
assert.ok(CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest').pubKeyHash !== undefined)
