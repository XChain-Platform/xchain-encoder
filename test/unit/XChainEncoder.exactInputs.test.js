// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Exact-input mode.
//
// A batch that stops mining can only be lifted by a child that descends from the
// WHOLE stuck chain, and normal selection cannot build one: it sorts the candidate
// set value-descending and stops as soon as the running total covers the outputs
// plus fee, so a caller naming N outpoints gets one input and a child that descends
// from one leg. The 2026-08-28 Dogecoin rescue had to hand-build those transactions
// outside the encoder for exactly this reason. options.exactInputs turns selection
// off: the caller's list is the input set, in the caller's order, all of it.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const validator = require('../../src/validator')

const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_BIG = 'a'.repeat(64)
const TXID_MID = 'b'.repeat(64)
const TXID_TINY = 'c'.repeat(64)

function makeSegwitUtxo (txid, vout, value, confirmations = 6) {
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  })
  return {
    txid,
    vout,
    value,
    confirmations,
    scriptPubKey: p2wpkh.output.toString('hex')
  }
}

function makeEncoder () {
  // dogecoin-regtest carries a dustThreshold in CryptoNetworks, which the change
  // math needs; bitcoin-regtest uses the bitcoinjs-lib built-in and has none.
  const encoder = new XChainEncoder(
    'dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => { throw new Error('no non-segwit input expected in this suite') }
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => { throw new Error('exact-input mode must never reach the tracker') }
  }
  return encoder
}

const DOGE_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('dogecoin-regtest')
const TEST_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf,
  network: DOGE_REGTEST
}).address
const PUBKEY_HEX = pubkeyBuf.toString('hex')

// The stuck chain's leftovers: one fat root and two dust-sized change outputs that
// value-descending selection reaches only after it has already stopped.
function stuckChainUtxos (confirmations = 0) {
  return [
    makeSegwitUtxo(TXID_BIG, 0, 100000000, confirmations),
    makeSegwitUtxo(TXID_MID, 1, 6000, confirmations),
    makeSegwitUtxo(TXID_TINY, 2, 5000, confirmations)
  ]
}

// createTransaction is positional; name the tail so the tests read as intent.
function createTx (encoder, utxos, overrides = {}) {
  const o = Object.assign({
    customOutputs: null, data: null, rawData: null, fee: 100000, rbf: false,
    encoding: null, change: TEST_ADDRESS, p2shHash: null, p2shHex: null,
    compressedPubKey: null, unconfirmed: true, options: null
  }, overrides)
  return encoder.createTransaction(
    utxos, PUBKEY_HEX, o.customOutputs, o.data, o.rawData, o.fee, o.rbf,
    o.encoding, o.change, o.p2shHash, o.p2shHex, o.compressedPubKey,
    o.unconfirmed, null, null, null, false, null, o.options)
}

function outpointsOf (psbt) {
  return psbt.txInputs.map((i) =>
    Buffer.from(i.hash).reverse().toString('hex') + ':' + i.index)
}

describe('XChainEncoder create_tx options.exactInputs', () => {

  it('greedy selection stops at sufficiency, so a named set is not the input set', async () => {
    // The defect this mode exists to fix, pinned so a regression is visible: the
    // caller named three outpoints and the child descends from one of them.
    const encoder = makeEncoder()
    const { psbt } = await createTx(encoder, stuckChainUtxos())
    assert.strictEqual(psbt.txInputs.length, 1)
    assert.deepStrictEqual(outpointsOf(psbt), [`${TXID_BIG}:0`])
  })

  it('spends every named outpoint, so a CPFP child descends from the whole chain', async () => {
    const encoder = makeEncoder()
    const { psbt } = await createTx(encoder, stuckChainUtxos(),
      { options: { exactInputs: true } })
    assert.deepStrictEqual(outpointsOf(psbt), [
      `${TXID_BIG}:0`, `${TXID_MID}:1`, `${TXID_TINY}:2`
    ])
  })

  it('keeps the caller order, so ins[0] is the outpoint the caller chose', async () => {
    // Not cosmetic: on the OP_RETURN/MULTISIGN path ins[0]'s txid IS the
    // obfuscation key, and a value sort would silently rebind it.
    const encoder = makeEncoder()
    const reordered = [
      makeSegwitUtxo(TXID_TINY, 2, 5000, 0),
      makeSegwitUtxo(TXID_BIG, 0, 100000000, 0),
      makeSegwitUtxo(TXID_MID, 1, 6000, 0)
    ]
    const { psbt } = await createTx(encoder, reordered,
      { options: { exactInputs: true } })
    assert.deepStrictEqual(outpointsOf(psbt), [
      `${TXID_TINY}:2`, `${TXID_BIG}:0`, `${TXID_MID}:1`
    ])
  })

  it('returns the surplus as change, which is itself the next CPFP handle', async () => {
    const encoder = makeEncoder()
    const { psbt } = await createTx(encoder, stuckChainUtxos(),
      { options: { exactInputs: true } })
    const total = 100000000 + 6000 + 5000
    const outputs = psbt.txOutputs
    assert.strictEqual(outputs.length, 1, 'payment-only rescue emits change alone')
    assert.strictEqual(outputs[0].address, TEST_ADDRESS)
    assert.strictEqual(outputs[0].value, total - 100000)
  })

  it('signals RBF on every input when rbf is set, not just the first', async () => {
    // The operator rescue combo: name the whole stuck set AND leave the child
    // replaceable, so a first fee guess that still does not clear can be raised.
    const encoder = makeEncoder()
    const { psbt } = await createTx(encoder, stuckChainUtxos(),
      { rbf: true, options: { exactInputs: true } })
    assert.strictEqual(psbt.txInputs.length, 3)
    for (const input of psbt.txInputs) {
      assert.strictEqual(input.sequence, 0xfffffffd)
    }
  })

  it('refuses an empty or absent utxos array instead of falling back to the tracker', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      () => createTx(encoder, [], { options: { exactInputs: true } }),
      /exactInputs requires a non-empty utxos array/)
    await assert.rejects(
      () => createTx(encoder, null, { options: { exactInputs: true } }),
      /exactInputs requires a non-empty utxos array/)
  })

  it('refuses to combine with p2shHash, whose inputs never pass through selection', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      () => createTx(encoder, stuckChainUtxos(), {
        p2shHash: TXID_BIG, p2shHex: '00', options: { exactInputs: true }
      }),
      /exactInputs cannot be combined with p2shHash/)
  })

  it('errors rather than silently dropping a named unconfirmed outpoint', async () => {
    // The CPFP-fatal silent failure: unconfirmed=false strips exactly the mempool
    // outputs the rescue has to descend from, and the caller would get a child
    // that descends from nothing and still does not mine.
    const encoder = makeEncoder()
    await assert.rejects(
      () => createTx(encoder, stuckChainUtxos(0),
        { unconfirmed: false, options: { exactInputs: true } }),
      new RegExp(`exactInputs names unconfirmed utxo ${TXID_BIG}:0`))
  })

  it('errors rather than silently deduplicating a repeated outpoint', async () => {
    const encoder = makeEncoder()
    const dupes = stuckChainUtxos().concat([makeSegwitUtxo(TXID_MID, 1, 6000, 0)])
    await assert.rejects(
      () => createTx(encoder, dupes, { options: { exactInputs: true } }),
      new RegExp(`exactInputs names outpoint ${TXID_MID}:1 more than once`))
  })

  it('leaves greedy selection alone when the flag is absent or explicitly false', async () => {
    const encoder = makeEncoder()
    for (const options of [null, {}, { exactInputs: false }]) {
      const { psbt } = await createTx(encoder, stuckChainUtxos(), { options })
      assert.strictEqual(psbt.txInputs.length, 1,
        `options ${JSON.stringify(options)} must not change selection`)
    }
  })

  describe('validator', () => {
    it('accepts exactInputs as a real boolean', () => {
      const params = validator.validateAll({
        pubkey: PUBKEY_HEX, options: { exactInputs: true }
      })
      assert.deepStrictEqual(params.options, { exactInputs: true })
    })

    it('refuses a stringly-typed exactInputs, which would read as true', () => {
      assert.throws(
        () => validator.validateAll({ pubkey: PUBKEY_HEX, options: { exactInputs: 'false' } }),
        /options\.exactInputs/)
    })

    it('still refuses an unknown options key and names exactInputs as valid', () => {
      assert.throws(
        () => validator.validateAll({ pubkey: PUBKEY_HEX, options: { exactInput: true } }),
        /Unknown options key: "exactInput"\. Valid keys: .*exactInputs/)
    })
  })
})
