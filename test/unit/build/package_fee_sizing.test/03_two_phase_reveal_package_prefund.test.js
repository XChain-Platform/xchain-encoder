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
const ecc = require('tiny-secp256k1');

const SATOSHI_UNIT = 100000000

const TXID_PARENT_A = 'a'.repeat(64)

// A reveal spends nothing but the commit's own outputs, so the pair is
// always one mempool package and a miner weighs them together. The reveal's fee
// is money the commit set aside and the reveal has no second input to raise it
// from, so a commit that lands under the target rate drags the package under it
// and nothing downstream can fix that: the pair sits unmined behind a confirmed
// commit. These pin that the commit prefunds the reveal at the PACKAGE rate, and
// that the P2SH reveal keeps that money as fee instead of sweeping it home.

const { ECPairFactory } = require('ecpair')
bitcoin.initEccLib(ecc)
const KEY = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY_HEX = Buffer.from(KEY.publicKey).toString('hex')

const BTC_REGTEST = require('../../../../src/build/crypto_networks').getBitcoinJsNetwork('bitcoin-regtest')
const BTC_RATE_KB = 0.0001                                  // 10 sat/byte
const BTC_TARGET_PER_BYTE = BTC_RATE_KB * SATOSHI_UNIT / 1000
const COMMIT_INPUT_VALUE = 100000000
// Far under the target rate for a commit of any size: the congestion-clamped
// commit the ledger entry describes, reproduced as an explicit caller fee.
const UNDER_TARGET_COMMIT_FEE = 700
const ENVELOPE_PAYLOAD = 'x'.repeat(20000)


function envelopeEncoder (ancestorPackage) {
  const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => BTC_RATE_KB,
    // Without a relayfee the suggested-rate ceiling clamps to its default and
    // the probe rate below would never be priced at all.
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async () => { throw new Error('unit test: no node') }
  }
  if (ancestorPackage !== undefined) {
    encoder.connector.getUnconfirmedAncestorPackage = async () =>
      (typeof ancestorPackage === 'function' ? ancestorPackage() : ancestorPackage)
  }
  return encoder
}

function callerAddress () {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network: BTC_REGTEST }).address
}

function segwitUtxo (value, confirmations) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(KEY.publicKey), network: BTC_REGTEST })
  return { txid: TXID_PARENT_A, vout: 0, value, confirmations, scriptPubKey: p2wpkh.output.toString('hex') }
}

async function buildEnvelope (encoder, { commitFee = null, inputValue = COMMIT_INPUT_VALUE, confirmations = 6 } = {}) {
  encoder.clearReservations()
  const addr = callerAddress()
  return encoder.createTransaction(
    [segwitUtxo(inputValue, confirmations)], addr, null, 'FILE|0|package-prefund',
    ENVELOPE_PAYLOAD, commitFee, false, 'TAPROOT', addr, null, null, PUBKEY_HEX)
}

function unsignedTx (psbt) {
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
}

// Sign both halves so the package is measured on the bytes a miner actually
// sees, not on the builder's own estimate of them.
function signedPair (result) {
  const signer = {
    publicKey: Buffer.from(KEY.publicKey),
    sign: (h) => Buffer.from(KEY.sign(h)),
    signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, KEY.privateKey))
  }
  const commitPsbt = bitcoin.Psbt.fromHex(result.psbt.toHex())
  commitPsbt.signAllInputs(signer)
  commitPsbt.finalizeAllInputs()
  const commitTx = commitPsbt.extractTransaction()

  const revealPsbt = result.revealPsbt
  revealPsbt.signInput(0, signer)
  revealPsbt.finalizeAllInputs()
  const revealTx = revealPsbt.extractTransaction()
  return { commitTx, revealTx }
}

describe('two-phase reveal package prefund @regression @tier1', () => {

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  it('lifts the prefund so a commit paying under the target rate still clears it as a package', async () => {
    const result = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })
    const { commitTx, revealTx } = signedPair(result)

    const commitFee = COMMIT_INPUT_VALUE - commitTx.outs.reduce((s, o) => s + o.value, 0)
    assert.strictEqual(commitFee, UNDER_TARGET_COMMIT_FEE, 'the commit still pays exactly what the caller asked')
    assert.ok(commitFee / commitTx.virtualSize() < BTC_TARGET_PER_BYTE,
      'this probe is only meaningful while the commit itself is under target')

    const revealFee = commitTx.outs[result.envelope.commitVout].value -
      revealTx.outs.reduce((s, o) => s + o.value, 0)
    const packageRate = (commitFee + revealFee) / (commitTx.virtualSize() + revealTx.virtualSize())
    assert.ok(packageRate >= BTC_TARGET_PER_BYTE,
      `commit+reveal package pays ${packageRate} sat/byte, under the ${BTC_TARGET_PER_BYTE} target`)
  })

  it('leaves the reveal its change output rather than paying the uplift out of it', async () => {
    const encoder = envelopeEncoder()
    const result = await buildEnvelope(encoder, { commitFee: UNDER_TARGET_COMMIT_FEE })
    // commitValue = revealFee + dust by construction; both move together or the
    // uplift silently returns to the caller as change instead of reaching miners.
    assert.strictEqual(result.envelope.commitValue, result.envelope.revealFee + encoder.dustAmount)
    assert.strictEqual(Number(result.revealPsbt.txOutputs[0].value), encoder.dustAmount,
      'the reveal still leaves exactly one dust output back to the caller')
    const commitTx = unsignedTx(result.psbt)
    assert.strictEqual(commitTx.outs[result.envelope.commitVout].value, result.envelope.commitValue,
      'the commit output on the wire carries the raised value')
  })

  it('adds nothing when the commit already pays the target rate on its own bytes', async () => {
    // Same build, node-derived fee: the commit pays the target, so the package
    // already clears it and the prefund must not grow by a single satoshi.
    const withPackaging = await buildEnvelope(envelopeEncoder())
    process.env.MAX_CPFP_UPLIFT_SAT = '0'
    const withoutPackaging = await buildEnvelope(envelopeEncoder())
    assert.strictEqual(withPackaging.envelope.revealFee, withoutPackaging.envelope.revealFee,
      'a commit at target must not buy the reveal a bigger prefund')
  })

})

describe('two-phase reveal package prefund @regression @tier1', () => {

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  it('carries ancestors the commit\'s own capped uplift could not pay for', async () => {
    // A commit whose CPFP uplift is capped at the node rate cannot pay for the
    // free ancestors it spends: the rate cap measures a fee against the commit's
    // OWN bytes, so there is no room in it for anyone else's. The reveal is the
    // only half of the package left that can still be raised, and its prefund is
    // bought with change rather than with commit fee, so the cap does not bind it.
    const capped = (ancestorPackage) => {
      const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '',
        BTC_RATE_KB * SATOSHI_UNIT)
      encoder.connector = {
        getFeePerKilobyte: async () => BTC_RATE_KB,
        getNetworkInfo: async () => ({ relayfee: 0.00001 }),
        getTransactionHex: async () => { throw new Error('unit test: no node') },
        getUnconfirmedAncestorPackage: async () => ancestorPackage
      }
      return encoder
    }
    const originalWarn = console.warn
    console.warn = () => {}
    let withAncestors, withoutAncestors
    try {
      withAncestors = await buildEnvelope(capped({ size: 2000, fees: 0 }), { confirmations: 0 })
      withoutAncestors = await buildEnvelope(capped({ size: 0, fees: 0 }), { confirmations: 0 })
    } finally {
      console.warn = originalWarn
    }
    assert.ok(withAncestors.envelope.revealFee > withoutAncestors.envelope.revealFee,
      `unpaid ancestors must raise the prefund (${withAncestors.envelope.revealFee} vs ${withoutAncestors.envelope.revealFee})`)
    // 2000 free ancestor bytes at the 10 sat/byte target is what is owed, give or
    // take the single base unit the rate's float representation costs.
    const owed = withAncestors.envelope.revealFee - withoutAncestors.envelope.revealFee
    assert.ok(Math.abs(owed - 2000 * BTC_TARGET_PER_BYTE) <= 1,
      `owed ${owed} against ${2000 * BTC_TARGET_PER_BYTE} for the unpaid ancestor bytes`)
  })

  it('MAX_CPFP_UPLIFT_SAT=0 turns the prefund off entirely', async () => {
    const baseline = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })
    process.env.MAX_CPFP_UPLIFT_SAT = '0'
    const disabled = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })
    assert.ok(baseline.envelope.revealFee > disabled.envelope.revealFee,
      'the probe must actually be lifting something when sizing is on')
  })

})

describe('two-phase reveal package prefund @regression @tier1', () => {

  afterEach(() => { delete process.env.MAX_CPFP_UPLIFT_SAT })

  it('clamps at MAX_CPFP_UPLIFT_SAT and warns that the package stays under target', async () => {
    process.env.MAX_CPFP_UPLIFT_SAT = '0'
    const disabled = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })

    process.env.MAX_CPFP_UPLIFT_SAT = '11'
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    let clamped
    try {
      clamped = await buildEnvelope(envelopeEncoder(), { commitFee: UNDER_TARGET_COMMIT_FEE })
    } finally {
      console.warn = originalWarn
    }
    assert.strictEqual(clamped.envelope.revealFee, disabled.envelope.revealFee + 11,
      'the prefund stops at exactly the configured bound')
    assert.ok(warnings.some(w => /Reveal package prefund clamped/.test(w) && /MAX_CPFP_UPLIFT_SAT/.test(w)),
      'the operator must be told the package will stay under target: ' + warnings.join(' | '))
  })

  it('never prefunds more than the commit inputs hold', async () => {
    // The input barely covers the commit's own outputs and fee. The build must
    // still produce a signable pair rather than fail with INSUFFICIENT_FUNDS.
    const encoder = envelopeEncoder({ size: 500000, fees: 0 })
    const result = await buildEnvelope(encoder, { commitFee: UNDER_TARGET_COMMIT_FEE, inputValue: 53000, confirmations: 0 })
    const commitTx = unsignedTx(result.psbt)
    const outputs = commitTx.outs.reduce((s, o) => s + o.value, 0)
    assert.ok(outputs + UNDER_TARGET_COMMIT_FEE <= 53000,
      `commit pays out ${outputs} + ${UNDER_TARGET_COMMIT_FEE} fee against a ${53000} input`)
    assert.strictEqual(result.envelope.commitValue, commitTx.outs[result.envelope.commitVout].value)
  })

})

