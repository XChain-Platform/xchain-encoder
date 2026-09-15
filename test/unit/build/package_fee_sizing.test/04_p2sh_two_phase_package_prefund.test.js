// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../../../src/XChainEncoder')

const SATOSHI_UNIT = 100000000

const TXID_PARENT_A = 'a'.repeat(64)

// The P2SH lane splits the two phases across two calls, so the commit funds the
// package rate into its first leg and the reveal has to KEEP that money as fee
// instead of sweeping it back to the caller.

const DOGE = 'dogecoin-regtest'
const DOGE_REGTEST_NET = require('../../../../src/build/crypto_networks').getBitcoinJsNetwork(DOGE)
const RATE_KB = 1000000                       // 1000 koinu/byte, the venue rate
const TARGET_PER_BYTE = RATE_KB / 1000
const pubkeyBuf = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')
const CALLER = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: DOGE_REGTEST_NET }).address
// Four inputs this size: selection takes two, which is enough to leave a
// change output at or above the 0.01 DOGE relay floor. That matters - a change
// that folds into the fee instead of being emitted quietly lifts the commit
// back over the target rate and the probe stops probing anything.
const FUNDING_INPUT = 2000000
const PAYLOAD = 'x'.repeat(400)
// The dust floor, and far under the target rate for a two-input funding tx:
// the congestion-clamped commit the ledger entry describes.
const UNDER_TARGET_COMMIT_FEE = 100000

function prevTxHex () {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  for (let i = 0; i < 4; i++) {
    tx.addOutput(bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest }).output, FUNDING_INPUT)
  }
  return tx.toHex()
}

function makeEncoder (commitPackage) {
  const encoder = new XChainEncoder(DOGE, '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.01,
    getTransactionHex: async () => prevTxHex()
  }
  if (commitPackage !== undefined) {
    encoder.connector.getUnconfirmedAncestorPackage = async () =>
      (typeof commitPackage === 'function' ? commitPackage() : commitPackage)
  }
  return encoder
}

function legacyUtxos () {
  const p2pkh = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: bitcoin.networks.regtest })
  return [0, 1, 2, 3].map(vout => ({
    txid: TXID_PARENT_A, vout, value: FUNDING_INPUT, confirmations: 6, scriptPubKey: p2pkh.output.toString('hex')
  }))
}

async function buildFunding (encoder, commitFee) {
  encoder.clearReservations()
  const res = await encoder.createTransaction(
    legacyUtxos(), CALLER, null, PAYLOAD, null, commitFee, false, 'P2SH', CALLER,
    null, null, null, true, RATE_KB)
  return res.psbt.__CACHE.__TX
}

async function buildReveal (encoder, fundingTx) {
  const res = await encoder.createTransaction(
    [], CALLER, null, PAYLOAD, null, null, false, 'P2SH', CALLER,
    fundingTx.getId(), fundingTx.toHex(), null, true, RATE_KB)
  return res.psbt.__CACHE.__TX
}

const legTotal = (tx) => tx.outs
  .filter(o => o.script.toString('hex').startsWith('a914'))
  .reduce((s, o) => s + o.value, 0)


describe('P2SH two-phase package prefund @regression @tier1', () => {

  it('funds the package rate into the leg when the commit pays under target', async () => {
    const atTarget = await buildFunding(makeEncoder(), null)
    const underTarget = await buildFunding(makeEncoder(), UNDER_TARGET_COMMIT_FEE)
    assert.ok(legTotal(underTarget) > legTotal(atTarget),
      `an under-target commit must over-fund its leg (${legTotal(underTarget)} vs ${legTotal(atTarget)})`)
  })

  it('the reveal keeps the package money as fee instead of sweeping it back', async () => {
    const funding = await buildFunding(makeEncoder(), UNDER_TARGET_COMMIT_FEE)
    const commitSize = funding.virtualSize()
    // What the commit ACTUALLY pays: a sub-floor change would have folded into
    // the fee and quietly lifted it back over target.
    const commitFee = funding.ins.length * FUNDING_INPUT - funding.outs.reduce((s, o) => s + o.value, 0)
    assert.ok(commitFee / commitSize < TARGET_PER_BYTE,
      `this probe is only meaningful while the commit is under target (${commitFee / commitSize})`)

    // The node reports the commit exactly as it was broadcast: its real size and
    // the under-target fee the caller chose.
    const packaged = await buildReveal(
      makeEncoder({ size: commitSize, fees: commitFee / SATOSHI_UNIT }), funding)
    // Control: the same reveal built against a node that cannot price the commit.
    const unpackaged = await buildReveal(makeEncoder(), funding)

    const legs = legTotal(funding)
    const packagedFee = legs - packaged.outs.reduce((s, o) => s + o.value, 0)
    const unpackagedFee = legs - unpackaged.outs.reduce((s, o) => s + o.value, 0)
    assert.ok(packagedFee > unpackagedFee,
      `the reveal must keep the package money (${packagedFee} vs ${unpackagedFee})`)

    // The reveal's own priced size, recovered from the control: at exactly
    // 1000 koinu/byte an unpackaged fee IS the size in bytes.
    const revealSize = unpackagedFee / TARGET_PER_BYTE
    const packageRate = (commitFee + packagedFee) / (commitSize + revealSize)
    assert.ok(packageRate >= TARGET_PER_BYTE,
      `commit+reveal package pays ${packageRate} koinu/byte, under the ${TARGET_PER_BYTE} target`)

    // And it is still not a full burn: the SDK refuses to sign an outputless reveal.
    const swept = packaged.outs.reduce((s, o) => s + o.value, 0)
    assert.ok(swept > 0, 'the reveal must still leave the caller an output')
  })

})

describe('P2SH two-phase package prefund @regression @tier1', () => {

  it('a confirmed commit asks the reveal for nothing', async () => {
    const funding = await buildFunding(makeEncoder(), UNDER_TARGET_COMMIT_FEE)
    // An empty package is what the connector reports once the commit confirms; a
    // confirmed parent is nobody's ancestor for fee purposes any more.
    const confirmed = await buildReveal(makeEncoder({ size: 0, fees: 0 }), funding)
    const unpackaged = await buildReveal(makeEncoder(), funding)
    assert.strictEqual(confirmed.toHex(), unpackaged.toHex(),
      'a confirmed commit must leave the reveal byte-identical')
  })

  it('degrades to the per-transaction fee when the commit lookup throws', async () => {
    const funding = await buildFunding(makeEncoder(), UNDER_TARGET_COMMIT_FEE)
    const thrown = await buildReveal(makeEncoder(() => { throw new Error('node RPC exploded') }), funding)
    const unpackaged = await buildReveal(makeEncoder(), funding)
    assert.strictEqual(thrown.toHex(), unpackaged.toHex())
  })

})

