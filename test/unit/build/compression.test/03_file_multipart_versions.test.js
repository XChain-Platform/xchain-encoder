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
 ********************************************************************/

'use strict'

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')

const XChainEncoder = require('../../../../src/XChainEncoder')
const { ENVELOPE_MAX_PAYLOAD, MAX_COMPILED_ACTION_DATA_LENGTH } = require('../../../../src/common/validator')

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

const KEY = ECPair.fromPrivateKey(Buffer.alloc(32, 7))
const PUBKEY = Buffer.from(KEY.publicKey)
const PUBKEY_HEX = PUBKEY.toString('hex')
const FILE_HASH = 'ab'.repeat(32)
const PART_ACTION = `FILE|2|${FILE_HASH}|0`
const MANIFEST_ACTION = [
  'FILE', '1', FILE_HASH, '2', '398034', 'file.bin',
  'application/octet-stream', 'Multipart file', '', '', '', '', '', ''
].join('|')

let previousTransactionSequence = 0

function makeEncoder () {
  const previousTransactions = new Map()
  const encoder = new XChainEncoder('bitcoin-regtest', '', '', '', '', '', '')
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async (txid) => {
      if (!previousTransactions.has(txid)) throw new Error(`missing previous transaction ${txid}`)
      return previousTransactions.get(txid)
    }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('the supplied utxos must be used') }
  }
  return { encoder, previousTransactions }
}

function payments (network) {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: PUBKEY, network })
  const p2pkh = bitcoin.payments.p2pkh({ pubkey: PUBKEY, network })
  const p2shP2wpkh = bitcoin.payments.p2sh({ redeem: p2wpkh, network })
  return { p2wpkh, p2pkh, p2shP2wpkh }
}

function fundedUtxo (previousTransactions, payment, value = 1000000000) {
  const previous = new bitcoin.Transaction()
  const seed = Buffer.alloc(32)
  seed.writeUInt32BE(++previousTransactionSequence, 0)
  previous.addInput(seed, 0)
  previous.addOutput(payment.output, value)
  previousTransactions.set(previous.getId(), previous.toHex())
  return {
    txid: previous.getId(),
    vout: 0,
    value,
    confirmations: 6,
    scriptPubKey: payment.output.toString('hex')
  }
}

function build (encoder, request) {
  return encoder.createTransaction(
    request.utxos,
    request.source,
    null,
    request.action,
    request.rawData === undefined ? null : request.rawData,
    null,
    false,
    request.encoding,
    request.change,
    request.p2shHash || null,
    request.p2shHex || null,
    request.compressedPubKey || null,
    true,
    null,
    null,
    null,
    false,
    request.compress === undefined ? null : request.compress,
    request.options || null
  )
}

function unsignedTransaction (psbt) {
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
}

function outpointsOf (psbt) {
  return psbt.txInputs.map(input =>
    `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`
  )
}

function envelopePayload (result) {
  const script = bitcoin.script.decompile(Buffer.from(result.carrierScripts[0], 'hex'))
  const end = script.lastIndexOf(bitcoin.opcodes.OP_ENDIF)
  return bitcoin.script.decompile(Buffer.concat(script.slice(4, end)))
}

async function buildP2shPair (encoder, request) {
  const funding = await build(encoder, { ...request, encoding: 'P2SH' })
  const fundingTransaction = unsignedTransaction(funding.psbt)
  encoder.clearReservations()
  const reveal = await build(encoder, {
    ...request,
    utxos: [],
    encoding: 'P2SH',
    p2shHash: fundingTransaction.getId(),
    p2shHex: fundingTransaction.toHex()
  })
  return { funding, reveal }
}

function registerRawDefaultCase () {
  it('keeps a version 2 part raw by default and carries no COMPRESSION field', async function () {
    const { encoder, previousTransactions } = makeEncoder()
    const { p2wpkh } = payments(encoder.network)
    const rawData = Buffer.from('multipart bytes are already stored bytes')
    const result = await build(encoder, {
      utxos: [fundedUtxo(previousTransactions, p2wpkh)],
      source: p2wpkh.address,
      action: PART_ACTION,
      rawData,
      encoding: 'TAPROOT',
      change: p2wpkh.address,
      compressedPubKey: PUBKEY_HEX
    })
    const payload = envelopePayload(result)

    assert.strictEqual(payload[0].toString('utf8'), PART_ACTION)
    assert.deepStrictEqual(payload[1], rawData)
    assert.strictEqual(PART_ACTION.split('|').length, 4)
    assert.deepStrictEqual(result.compression, {
      compressed: false,
      rawLength: rawData.length,
      storedLength: rawData.length,
      reason: 'not-a-file-action'
    })
  })
}

function registerCompressionRefusalCase () {
  it('refuses explicit compression of a version 2 part at guard 1', async function () {
    const { encoder, previousTransactions } = makeEncoder()
    const { p2wpkh } = payments(encoder.network)

    await assert.rejects(
      build(encoder, {
        utxos: [fundedUtxo(previousTransactions, p2wpkh)],
        source: p2wpkh.address,
        action: PART_ACTION,
        rawData: Buffer.from('stored multipart bytes'),
        encoding: 'TAPROOT',
        change: p2wpkh.address,
        compressedPubKey: PUBKEY_HEX,
        compress: true
      }),
      /COMPRESSION is a FILE v0 field/
    )
  })
}

function registerTaprootSizeCase () {
  it('builds a 389,920-byte part as a TAPROOT pair from every exact P2WPKH output', async function () {
    const { encoder, previousTransactions } = makeEncoder()
    const { p2wpkh } = payments(encoder.network)
    const chosen = fundedUtxo(previousTransactions, p2wpkh)
    const extra = fundedUtxo(previousTransactions, p2wpkh, 10000)
    const rawData = Buffer.alloc(389920, 0x7a)
    const compiled = bitcoin.script.compile([Buffer.from(PART_ACTION), rawData])
    assert.strictEqual(compiled.length, ENVELOPE_MAX_PAYLOAD - 1)

    const result = await build(encoder, {
      utxos: [chosen, extra],
      source: p2wpkh.address,
      action: PART_ACTION,
      rawData,
      encoding: 'TAPROOT',
      change: p2wpkh.address,
      compressedPubKey: PUBKEY_HEX,
      options: { exactInputs: true }
    })

    assert.strictEqual(result.encoding, 'TAPROOT')
    assert.ok(result.psbt)
    assert.ok(result.revealPsbt)
    assert.ok(result.envelope)
    assert.deepStrictEqual(outpointsOf(result.psbt), [
      `${chosen.txid}:0`,
      `${extra.txid}:0`
    ])
  })
}

function registerManifestCase () {
  it('builds a version 1 manifest without rawData', async function () {
    const { encoder, previousTransactions } = makeEncoder()
    const { p2wpkh } = payments(encoder.network)
    const result = await build(encoder, {
      utxos: [fundedUtxo(previousTransactions, p2wpkh)],
      source: p2wpkh.address,
      action: MANIFEST_ACTION,
      encoding: 'TAPROOT',
      change: p2wpkh.address,
      compressedPubKey: PUBKEY_HEX
    })

    assert.strictEqual(result.encoding, 'TAPROOT')
    assert.ok(result.psbt)
    assert.ok(result.revealPsbt)
    assert.strictEqual(result.compression, undefined)
    const payload = envelopePayload(result)
    assert.strictEqual(payload.length, 1)
    assert.strictEqual(payload[0].toString('utf8'), MANIFEST_ACTION)
  })
}

function registerTaprootSourceRefusalCases () {
  for (const sourceType of ['P2PKH', 'P2SH-P2WPKH']) {
    it(`refuses a ${sourceType} source for a TAPROOT pair`, async function () {
      const { encoder, previousTransactions } = makeEncoder()
      const { p2pkh, p2shP2wpkh } = payments(encoder.network)
      const payment = sourceType === 'P2PKH' ? p2pkh : p2shP2wpkh

      await assert.rejects(
        build(encoder, {
          utxos: [fundedUtxo(previousTransactions, payment)],
          source: payment.address,
          action: PART_ACTION,
          rawData: Buffer.from('stored multipart bytes'),
          encoding: 'TAPROOT',
          change: payment.address,
          compressedPubKey: PUBKEY_HEX
        }),
        /TAPROOT commit inputs must be native-segwit/
      )
    })
  }
}

function registerP2shSizeCase () {
  it('builds an 8,114-byte part as a P2SH pair from a P2PKH source', async function () {
    const { encoder, previousTransactions } = makeEncoder()
    const { p2pkh } = payments(encoder.network)
    const rawData = Buffer.alloc(8114, 0x7a)
    const compiled = bitcoin.script.compile([Buffer.from(PART_ACTION), rawData])
    assert.strictEqual(compiled.length, MAX_COMPILED_ACTION_DATA_LENGTH - 1)

    const pair = await buildP2shPair(encoder, {
      utxos: [fundedUtxo(previousTransactions, p2pkh)],
      source: p2pkh.address,
      action: PART_ACTION,
      rawData,
      change: p2pkh.address
    })

    assert.strictEqual(pair.funding.encoding, 'P2SH')
    assert.strictEqual(pair.reveal.encoding, 'P2SH')
    assert.ok(pair.funding.psbt.data.inputs[0].nonWitnessUtxo)
    assert.strictEqual(pair.reveal.psbt.txInputs.length, pair.funding.carrierScripts.length)
  })
}

describe('encoder FILE multipart versions', function () {
  this.timeout(10000)

  registerRawDefaultCase()
  registerCompressionRefusalCase()
  registerTaprootSizeCase()
  registerManifestCase()
  registerTaprootSourceRefusalCases()
  registerP2shSizeCase()
})
