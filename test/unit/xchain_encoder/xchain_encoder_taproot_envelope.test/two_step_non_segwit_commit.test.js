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
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const XChainEncoder = require('../../../../src/XChainEncoder')
const validator = require('../../../../src/common/validator')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 19))
const PUBKEY = Buffer.from(KEY.publicKey)
const PUBKEY_HEX = PUBKEY.toString('hex')

function signer () {
  return {
    publicKey: PUBKEY,
    sign: hash => Buffer.from(KEY.sign(hash))
  }
}

function revealSigner () {
  return {
    publicKey: PUBKEY,
    signSchnorr: hash => Buffer.from(ecc.signSchnorr(hash, KEY.privateKey))
  }
}

function fundingTransaction (script, value) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 3), 0xffffffff, 0xffffffff, Buffer.from([0]))
  tx.addOutput(script, value)
  return tx
}

function fixture (kind, floorMultiplier) {
  const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  if (floorMultiplier) encoder.outputFloor = encoder.dustAmount * floorMultiplier
  const network = encoder.network
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network })
  const payment = kind === 'p2pkh'
    ? bitcoin.payments.p2pkh({ pubkey: PUBKEY, network })
    : bitcoin.payments.p2sh({ redeem: p2wpkh, network })
  const previous = fundingTransaction(payment.output, 1000000)
  const utxo = {
    txid: previous.getId(),
    vout: 0,
    value: 1000000,
    confirmations: 6,
    scriptPubKey: payment.output.toString('hex')
  }
  let feeEstimate = 0.00001
  encoder.connector = {
    getFeePerKilobyte: async () => feeEstimate,
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async txid => {
      if (txid !== previous.getId()) throw new Error('unexpected previous transaction')
      return previous.toHex()
    }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('unit test: no tracker') }
  }
  return { encoder, utxo, source: payment.address, setFeeEstimate: value => { feeEstimate = value } }
}

async function buildPair (kind, floorMultiplier, revealEstimate, commitSetup = {}) {
  const { encoder, utxo, source, setFeeEstimate } = fixture(kind, floorMultiplier)
  if (commitSetup.estimate) setFeeEstimate(commitSetup.estimate)
  const args = [
    [utxo], source, null, `FILE|0|two-step-${kind}`, 'payload',
    commitSetup.fee || null, false, 'TAPROOT', source, null, null, PUBKEY_HEX
  ]
  const commit = await encoder.createTransaction(...args, true, null, null, null, false, false, {
    twoStepEnvelope: true
  })
  assert.strictEqual(commit.revealPsbt, undefined)
  assert.strictEqual(commit.envelope.commitTxid, undefined)
  assert.strictEqual(commit.carrierScripts.length, 1)

  const unsignedHex = commit.psbt.data.globalMap.unsignedTx.toBuffer().toString('hex')
  commit.psbt.signAllInputs(signer())
  commit.psbt.finalizeAllInputs()
  const commitTx = commit.psbt.extractTransaction()
  assert.notStrictEqual(commitTx.getId(), bitcoin.Transaction.fromHex(unsignedHex).getId())

  if (revealEstimate) setFeeEstimate(revealEstimate)
  const reveal = await encoder.createTransaction(...args, true, null, null, null, false, false, {
    envelopeCommitHex: commitTx.toHex()
  })
  assert.strictEqual(reveal.revealPsbt, undefined)
  assert.strictEqual(reveal.envelope.commitTxid, commitTx.getId())
  assert.strictEqual(Buffer.from(commitTx.ins[0].hash).reverse().toString('hex'), utxo.txid)
  assert.strictEqual(commitTx.ins[0].index, utxo.vout)
  assert.strictEqual(Buffer.from(reveal.psbt.txInputs[0].hash).reverse().toString('hex'), commitTx.getId())
  assert.strictEqual(reveal.psbt.txInputs[0].index, 0)
  assert.strictEqual(reveal.psbt.data.inputs[0].tapLeafScript[0].script.toString('hex'), commit.carrierScripts[0])

  reveal.psbt.signInput(0, revealSigner())
  reveal.psbt.finalizeAllInputs()
  const revealTx = reveal.psbt.extractTransaction()
  assert.strictEqual(Buffer.from(revealTx.ins[0].hash).reverse().toString('hex'), commitTx.getId())
  assert.strictEqual(revealTx.ins[0].index, 0)

  return { encoder, args, unsignedHex, commit, commitTx, reveal, revealTx }
}

// The fee a finalized reveal actually pays: its only input is the commit output.
function paidRevealFee (commitTx, revealTx) {
  const spent = Number(commitTx.outs[revealTx.ins[0].index].value)
  return spent - revealTx.outs.reduce((sum, out) => sum + Number(out.value), 0)
}

// A signed-looking commit paying `value` to the envelope address the encoder derives.
function handBuiltCommit (encoder, commit, value) {
  const tx = new bitcoin.Transaction()
  tx.version = 2
  tx.addInput(Buffer.alloc(32, 7), 0, 0xfffffffd)
  tx.setWitness(0, [Buffer.alloc(64, 1)])
  tx.addOutput(bitcoin.address.toOutputScript(commit.envelope.commitAddress, encoder.network), value)
  return tx
}

function registerBuildCases () {
  it('builds and finalizes a P2PKH-funded commit and reveal with source attribution at input 0', async function () {
    await buildPair('p2pkh')
  })

  it('builds and finalizes a P2SH-P2WPKH-funded commit and reveal with source attribution at input 0', async function () {
    await buildPair('p2sh-p2wpkh')
  })

  it('prefunds and emits the two-step reveal change at a raised operator output floor', async function () {
    const { encoder, reveal, revealTx } = await buildPair('p2pkh', 4)
    assert.ok(encoder.outputFloor > encoder.dustAmount)
    assert.strictEqual(reveal.envelope.commitValue, reveal.envelope.revealFee + encoder.outputFloor)
    assert.strictEqual(revealTx.outs.length, 1)
    assert.strictEqual(Number(revealTx.outs[0].value), encoder.outputFloor)
  })

  it('builds the reveal when the node fee estimate changes after commit signing', async function () {
    const { commit, reveal } = await buildPair('p2pkh', null, 0.0003, { estimate: 0.0001 })
    assert.strictEqual(reveal.envelope.commitValue, commit.envelope.commitValue)
  })
}

function registerReservationCases () {
  it('reports the reserved envelope commit outpoint with its own reason and data', async function () {
    const { encoder, args, commitTx } = await buildPair('p2pkh')
    const outpoint = `${commitTx.getId()}:0`
    await assert.rejects(
      encoder.createTransaction(...args, true, null, null, null, false, false, {
        envelopeCommitHex: commitTx.toHex()
      }),
      err => err.operational === true &&
        err.xchainCode === 'ENVELOPE_COMMIT_OUTPOINT_RESERVED' &&
        err.details.outpoint === outpoint
    )
  })

  it('reports a commit outpoint held by an ordinary input claim without naming a reveal or cancel holder', async function () {
    const { encoder, args, commitTx, reveal } = await buildPair('p2pkh')
    const outpoint = `${commitTx.getId()}:0`
    assert.ok(reveal.reservation && reveal.reservation.outpoints.includes(outpoint))
    assert.strictEqual(encoder.releaseReservation(reveal.reservation.id).found, true)
    assert.strictEqual(encoder.isOutpointReserved(outpoint, Date.now()), false)
    // Releasing the holder's ticket is enough to rebuild the reveal: the
    // duplicate-build record rides on the same ticket and goes with it.
    const rebuilt = await encoder.createTransaction(...args, true, null, null, null, false, false, {
      envelopeCommitHex: commitTx.toHex()
    })
    assert.strictEqual(rebuilt.envelope.commitTxid, commitTx.getId())
    assert.strictEqual(encoder.releaseReservation(rebuilt.reservation.id).found, true)
    // The same claim input selection takes for any create_tx that picks this
    // output; the map stores only an expiry, so the state matches a real one.
    encoder.claimOutpoint([], outpoint, Date.now())
    await assert.rejects(
      encoder.createTransaction(...args, true, null, null, null, false, false, {
        envelopeCommitHex: commitTx.toHex()
      }),
      err => err.xchainCode === 'ENVELOPE_COMMIT_OUTPOINT_RESERVED' &&
        err.details.outpoint === outpoint &&
        /reserved by another transaction/.test(err.message) &&
        !/earlier reveal or cancel/.test(err.message)
    )
  })
}

function registerCancelReservationCase () {
  it('reports a commit outpoint held by an envelope cancel with the reveal reason and data', async function () {
    const { encoder, args, commitTx, reveal } = await buildPair('p2pkh')
    const outpoint = `${commitTx.getId()}:0`
    assert.strictEqual(encoder.releaseReservation(reveal.reservation.id).found, true)
    const destination = bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network: encoder.network }).address
    await encoder.createEnvelopeCancelTransaction({
      commitTxid: commitTx.getId(),
      commitVout: 0,
      commitValue: reveal.envelope.commitValue,
      internalPubkey: reveal.envelope.internalPubkey,
      tapleafHash: reveal.envelope.tapleafHash,
      destination
    })
    await assert.rejects(
      encoder.createTransaction(...args, true, null, null, null, false, false, {
        envelopeCommitHex: commitTx.toHex()
      }),
      err => err.xchainCode === 'ENVELOPE_COMMIT_OUTPOINT_RESERVED' && err.details.outpoint === outpoint
    )
  })
}

function registerValidationCases () {
  it('refuses an unsigned envelopeCommitHex', async function () {
    const { encoder, args, unsignedHex } = await buildPair('p2pkh')
    await assert.rejects(
      encoder.createTransaction(...args, true, null, null, null, false, false, {
        envelopeCommitHex: unsignedHex
      }),
      /must be fully signed/
    )
  })

  it('accepts the two-step option keys while still refusing unknown option keys', function () {
    const base = {
      pubkey: 'sender',
      data: 'FILE|0|options',
      encoding: 'TAPROOT',
      compressedPubKey: PUBKEY_HEX
    }
    assert.doesNotThrow(() => validator.validateAll({ ...base, options: { twoStepEnvelope: true } }))
    assert.throws(
      () => validator.validateAll({ ...base, options: { twoStepEnvelop: true } }),
      /Unknown options key/
    )
  })
}

describe('XChainEncoder TAPROOT two-step envelope for non-native-segwit commits', function () {
  registerBuildCases()
  registerReservationCases()
  registerCancelReservationCase()
  registerValidationCases()
})

describe('XChainEncoder TAPROOT two-step reveal binds the signed commit value', function () {
  it('keeps the signed commit fee when the node estimate rises after commit signing', async function () {
    const { encoder, commit, commitTx, reveal, revealTx } = await buildPair('p2pkh', null, 0.0003, { estimate: 0.0001 })
    assert.ok(commit.envelope.revealFee > encoder.dustAmount, 'commit fee must sit above the dust floor to move with the rate')
    assert.strictEqual(Number(reveal.psbt.data.inputs[0].witnessUtxo.value), Number(commitTx.outs[0].value))
    assert.strictEqual(reveal.envelope.revealFee, commit.envelope.revealFee)
    assert.strictEqual(paidRevealFee(commitTx, revealTx), commit.envelope.revealFee)
  })

  it('keeps the signed commit fee when the node estimate falls after commit signing', async function () {
    const { encoder, commit, commitTx, reveal, revealTx } = await buildPair('p2pkh', null, 0.0001, { estimate: 0.0003 })
    assert.ok(commit.envelope.revealFee / 2 > encoder.dustAmount, 'the lower rate must still price above the dust floor')
    assert.strictEqual(reveal.envelope.commitValue, Number(commitTx.outs[0].value))
    assert.strictEqual(reveal.envelope.revealFee, commit.envelope.revealFee)
    assert.strictEqual(paidRevealFee(commitTx, revealTx), commit.envelope.revealFee)
  })

  it('reveals a commit whose reveal fee was raised by the package prefund', async function () {
    const unprefunded = (await buildPair('p2pkh', null, null, { estimate: 0.0001 })).commit.envelope.revealFee
    const { commit, commitTx, reveal, revealTx } = await buildPair('p2pkh', null, null, { estimate: 0.0001, fee: 700 })
    assert.ok(commit.envelope.revealFee > unprefunded, `prefund did not fire: ${commit.envelope.revealFee}`)
    assert.strictEqual(reveal.envelope.commitValue, commit.envelope.commitValue)
    assert.strictEqual(reveal.envelope.revealFee, commit.envelope.revealFee)
    assert.strictEqual(paidRevealFee(commitTx, revealTx), commit.envelope.revealFee)
  })

  it('refuses a commit output too small to fund a relayable reveal', async function () {
    const { encoder, args, commit } = await buildPair('p2pkh')
    const change = commit.envelope.commitValue - commit.envelope.revealFee
    const underfunded = handBuiltCommit(encoder, commit, change + 1)
    await assert.rejects(
      encoder.createTransaction(...args, true, null, null, null, false, false, {
        envelopeCommitHex: underfunded.toHex()
      }),
      err => err.xchainCode === 'ENVELOPE_COMMIT_UNDERFUNDED' && /create_envelope_cancel_tx/.test(err.message)
    )
  })

  it('returns commit value above the burn ceiling as reveal change instead of miner fee', async function () {
    const { encoder, args, commit } = await buildPair('p2pkh')
    const overfunded = handBuiltCommit(encoder, commit, 500000)
    const reveal = await encoder.createTransaction(...args, true, null, null, null, false, false, {
      envelopeCommitHex: overfunded.toHex()
    })
    const outs = reveal.psbt.txOutputs
    assert.strictEqual(reveal.envelope.commitValue, 500000)
    assert.strictEqual(reveal.envelope.revealFee, commit.envelope.revealFee)
    assert.strictEqual(outs.length, 1)
    assert.strictEqual(Number(outs[0].value), 500000 - commit.envelope.revealFee)
  })
})
