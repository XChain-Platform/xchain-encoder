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
 **********************************************************************
 * REG-14: the P2SH/P2WSH reveal must clear the 1 sat/vB relay floor .
 *
 * The two-transaction flow funds the reveal (phase-2) transaction entirely
 * from the funding (phase-1) data outputs: whatever those outputs carry, minus
 * what the reveal pays out, IS the reveal's miner fee. The funding side sized
 * those outputs from "one data input + the OP_RETURN marker" and never charged
 * for the customOutputs the reveal has to emit (the native-fee output), so a
 * single-chunk reveal came out ~25 bytes short of the floor and the node
 * rejected it with min-relay-fee-not-met (observed on the devhost
 * bitcoin-regtest stack: 649 < 675, 582 < 607, 546 < 569).
 *
 * These tests build both transactions with the real encoder, then sign and
 * finalize them exactly as xchain-e2e-test/test/transactionHelper.js does, and
 * assert the reveal's realised fee covers its realised vsize.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')
const XChainEncoder = require('../../src/XChainEncoder')
const TxSizeEstimator = require('../../src/TxSizeEstimator')

const ECPair = ECPairFactory(ecc)
const NET = bitcoin.networks.regtest
const DUST = 546
const FEE_PER_KB = 1000 // 1000 sat/kB == the 1 sat/vB min-relay floor

const key = ECPair.fromPrivateKey(Buffer.alloc(32, 0x07), { network: NET })
const PUBKEY = Buffer.from(key.publicKey)
const SEGWIT = bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network: NET })
const SEGWIT_ADDRESS = SEGWIT.address
const LEGACY_ADDRESS = bitcoin.payments.p2pkh({ pubkey: PUBKEY, network: NET }).address

// Same shape as the e2e suite's finalizer: sig + pubkey pushed ahead of the
// data-bearing redeem/witness script.
function revealFinalizer (inputIndex, input, script, isSegwit, isP2SH, isP2WSH) {
  const redeem = {
    network: NET,
    input: bitcoin.script.compile([
      input.partialSig[0].signature,
      input.partialSig[0].pubkey
    ]),
    output: script
  }
  if (isP2SH) {
    const payment = bitcoin.payments.p2sh({ network: NET, redeem })
    return { finalScriptSig: payment.input, finalScriptWitness: undefined }
  }
  if (isP2WSH) {
    const payment = bitcoin.payments.p2wsh({ network: NET, redeem })
    return {
      finalScriptSig: undefined,
      finalScriptWitness: psbtutils.witnessStackToScriptWitness(payment.witness)
    }
  }
  throw new Error(`input #${inputIndex} is neither P2SH nor P2WSH`)
}

function makeEncoder () {
  const encoder = new XChainEncoder(
    'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  // bitcoin-regtest uses bitcoinjs-lib's built-in network object, which has no
  // dustThreshold, so pin the floor the live stack uses.
  encoder.dustAmount = DUST
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => ({ hex: '' })
  }
  encoder.utxoTrackerConnector = { getUtxosFromAddress: async () => ({ utxos: [] }) }
  return encoder
}

// Runs the full two-phase flow and reports what the reveal actually costs.
async function buildRevealed (payload, { encoding = 'P2SH', customOutputs = null } = {}) {
  const encoder = makeEncoder()
  const fundingUtxo = {
    txid: 'c'.repeat(64),
    vout: 0,
    value: 100000000,
    confirmations: 6,
    scriptPubKey: SEGWIT.output.toString('hex')
  }
  // customOutputs is mutated by the encoder (feeQuote injection), so hand each
  // phase its own copy, exactly like the e2e helper hands the same list twice.
  const copyOutputs = () => customOutputs && customOutputs.map((o) => ({ ...o }))

  const funding = await encoder.createTransaction(
    [fundingUtxo], SEGWIT_ADDRESS, copyOutputs(), payload, null, null, false,
    encoding, SEGWIT_ADDRESS, null, null, PUBKEY.toString('hex'), true, FEE_PER_KB, DUST
  )
  const fundingPsbt = funding.psbt
  for (let i = 0; i < fundingPsbt.data.inputs.length; i++) fundingPsbt.signInput(i, key)
  fundingPsbt.finalizeAllInputs()
  const fundingTx = fundingPsbt.extractTransaction()

  const reveal = await encoder.createTransaction(
    [], SEGWIT_ADDRESS, copyOutputs(), payload, null, null, false,
    encoding, SEGWIT_ADDRESS, fundingTx.getId(), fundingTx.toHex(),
    PUBKEY.toString('hex'), false, FEE_PER_KB, DUST
  )
  const revealPsbt = reveal.psbt
  for (let i = 0; i < revealPsbt.data.inputs.length; i++) revealPsbt.signInput(i, key)
  for (let i = 0; i < revealPsbt.data.inputs.length; i++) {
    revealPsbt.finalizeInput(i, revealFinalizer)
  }
  revealPsbt.setMaximumFeeRate(1000000)
  const revealTx = revealPsbt.extractTransaction()

  let spent = 0
  for (const input of revealTx.ins) spent += fundingTx.outs[input.index].value
  let paid = 0
  for (const out of revealTx.outs) paid += out.value

  return {
    chunks: revealPsbt.data.inputs.length,
    fee: spent - paid,
    vsize: revealTx.virtualSize(),
    revealOutputs: revealTx.outs.length
  }
}

describe('REG-14: P2SH/P2WSH reveal clears the min-relay fee floor ', () => {

  // 400 bytes compiles to a single data chunk whose reveal lands well above the
  // dust floor, so the fee is estimate-driven: the exact regime that failed.
  const SINGLE_CHUNK = 'Z'.repeat(400)
  // Small payloads land on the dust floor instead; 546 sat covered the reveal
  // right up until an unfunded 34-byte fee output pushed it past 546 vbytes.
  const DUST_FLOORED = 'Z'.repeat(340)
  const MULTI_CHUNK = 'Z'.repeat(1024)

  const nativeFeeOutput = (address) => [{ address, value: 5000 }]

  for (const encoding of ['P2SH', 'P2WSH']) {
    describe(encoding, () => {
      it('funds a reveal with no customOutputs', async () => {
        const r = await buildRevealed(SINGLE_CHUNK, { encoding })
        assert.strictEqual(r.revealOutputs >= 1, true)
        assert.ok(r.fee >= r.vsize,
          `reveal pays ${r.fee} sat for ${r.vsize} vbytes (below the 1 sat/vB floor)`)
      })

      it('funds a reveal carrying a legacy-address fee output', async () => {
        const r = await buildRevealed(SINGLE_CHUNK, {
          encoding, customOutputs: nativeFeeOutput(LEGACY_ADDRESS)
        })
        assert.strictEqual(r.revealOutputs, 2, 'the fee output rides the reveal')
        assert.ok(r.fee >= r.vsize,
          `reveal pays ${r.fee} sat for ${r.vsize} vbytes (below the 1 sat/vB floor)`)
      })

      it('funds a reveal carrying a segwit-address fee output', async () => {
        const r = await buildRevealed(SINGLE_CHUNK, {
          encoding, customOutputs: nativeFeeOutput(SEGWIT_ADDRESS)
        })
        assert.ok(r.fee >= r.vsize,
          `reveal pays ${r.fee} sat for ${r.vsize} vbytes (below the 1 sat/vB floor)`)
      })

      it('funds a dust-floored reveal carrying a fee output', async () => {
        const r = await buildRevealed(DUST_FLOORED, {
          encoding, customOutputs: nativeFeeOutput(LEGACY_ADDRESS)
        })
        assert.ok(r.fee >= r.vsize,
          `reveal pays ${r.fee} sat for ${r.vsize} vbytes (below the 1 sat/vB floor)`)
      })

      it('funds a multi-chunk reveal carrying a fee output', async () => {
        const r = await buildRevealed(MULTI_CHUNK, {
          encoding, customOutputs: nativeFeeOutput(LEGACY_ADDRESS)
        })
        assert.ok(r.chunks > 1, 'payload should span several data chunks')
        assert.ok(r.fee >= r.vsize,
          `reveal pays ${r.fee} sat for ${r.vsize} vbytes (below the 1 sat/vB floor)`)
      })
    })
  }

  it('charges the funding tx exactly the fee output byte cost it forgot before', async () => {
    // The regression in one number: the only difference between these two runs
    // is one 34-byte P2PKH output on the reveal, so the funding outputs must
    // grow by its value plus its 34 sat of fee at 1 sat/vB.
    const bare = await buildRevealed(SINGLE_CHUNK, { encoding: 'P2SH' })
    const withFee = await buildRevealed(SINGLE_CHUNK, {
      encoding: 'P2SH', customOutputs: nativeFeeOutput(LEGACY_ADDRESS)
    })
    const outputBytes = TxSizeEstimator.estimateOutputSizeForAddress(LEGACY_ADDRESS, NET)
    assert.strictEqual(outputBytes, 34)
    assert.strictEqual(withFee.fee - bare.fee, outputBytes)
  })
})
