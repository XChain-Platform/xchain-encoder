/**
 * Chaos Engineering — Category C: Library & Crypto Failures
 *
 * Tests encoder resilience when bitcoinjs-lib and Node.js crypto
 * internals fail. Uses monkey-patching with strict save/restore.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const crypto = require('crypto')
const {
  TXID_A, PUBKEY_BUF, makeSegwitUtxo, makeEncoder, getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const DOGE = 'dogecoin-regtest'
const DOGE_ADDR = getTestAddress(DOGE)

describe('Chaos Category C: Library & Crypto Failures', () => {

  // ── C-1: Psbt.addInput() rejection ────────────────────────────

  describe('C-1: Psbt.addInput() throws', () => {
    let _origAddInput

    before(() => {
      _origAddInput = bitcoin.Psbt.prototype.addInput
      bitcoin.Psbt.prototype.addInput = function () {
        throw new Error('chaos: addInput rejected')
      }
    })

    after(() => {
      bitcoin.Psbt.prototype.addInput = _origAddInput
    })

    it('addInput failure propagates from createTransaction', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], DOGE_ADDR, null,
          actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        ),
        /chaos: addInput rejected/
      )
    })
  })

  // ── C-2: Psbt.addOutput() rejection ───────────────────────────

  describe('C-2a: Psbt.addOutput() all calls fail', () => {
    let _origAddOutput

    before(() => {
      _origAddOutput = bitcoin.Psbt.prototype.addOutput
      bitcoin.Psbt.prototype.addOutput = function () {
        throw new Error('chaos: addOutput rejected')
      }
    })

    after(() => {
      bitcoin.Psbt.prototype.addOutput = _origAddOutput
    })

    it('first addOutput (OP_RETURN data) failure propagates', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], DOGE_ADDR, null,
          actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        ),
        /chaos: addOutput rejected/
      )
    })
  })

  describe('C-2b: Psbt.addOutput() fails on Nth call only', () => {
    let _origAddOutput
    let outputCallCount

    before(() => {
      _origAddOutput = bitcoin.Psbt.prototype.addOutput
      outputCallCount = 0
      bitcoin.Psbt.prototype.addOutput = function (...args) {
        outputCallCount++
        if (outputCallCount === 2) throw new Error('chaos: second addOutput rejected')
        return _origAddOutput.apply(this, args)
      }
    })

    after(() => {
      bitcoin.Psbt.prototype.addOutput = _origAddOutput
    })

    it('second addOutput (change output) failure propagates', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], DOGE_ADDR, null,
          actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        ),
        /chaos: second addOutput rejected/
      )
    })
  })

  // ── C-3: crypto.createCipheriv failure ────────────────────────

  describe('C-3: crypto.createCipheriv failure', () => {
    let _origCreateCipheriv

    before(() => {
      _origCreateCipheriv = crypto.createCipheriv
      crypto.createCipheriv = function () {
        throw new Error('chaos: createCipheriv failed (FIPS mode)')
      }
    })

    after(() => {
      crypto.createCipheriv = _origCreateCipheriv
    })

    it('cipher failure in obfuscate() propagates', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], DOGE_ADDR, null,
          actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        ),
        /chaos: createCipheriv failed/
      )
    })
  })

  // ── C-4: bitcoin.script.compile failure ───────────────────────

  describe('C-4: bitcoin.script.compile failure', () => {
    let _origCompile
    let encoder
    let utxo

    before(() => {
      // Create encoder BEFORE patching, since makeEncoder uses
      // script.compile internally via buildRawTxHex → p2pkh
      encoder = makeEncoder(DOGE)
      utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      _origCompile = bitcoin.script.compile
      bitcoin.script.compile = function () {
        throw new TypeError('chaos: script compile failed')
      }
    })

    after(() => {
      bitcoin.script.compile = _origCompile
    })

    it('compile failure on initial data buffer propagates TypeError', async () => {
      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], DOGE_ADDR, null,
          actions.makeSend().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        ),
        /chaos: script compile failed/
      )
    })
  })

  // ── C-5: Cross-network pubkey for P2SH ────────────────────────
  // No monkey-patching needed — uses real encoder with bech32 address

  describe('C-5: Cross-network / invalid pubkey for P2SH encoding', () => {
    it('bech32 address as pubkey → fromBase58Check throws', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Generate a bech32 regtest address
      const bech32Addr = bitcoin.payments.p2wpkh({
        pubkey: PUBKEY_BUF,
        network: bitcoin.networks.regtest
      }).address

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], bech32Addr, null,
          actions.makeIssueFull().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        ),
        /Non-base58|Invalid checksum|Invalid address/i
      )
    })

    it('hex string as pubkey → fromBase58Check throws', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], 'deadbeefdeadbeef', null,
          actions.makeIssueFull().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        ),
        /Non-base58|Invalid checksum|Invalid address|decode/i
      )
    })
  })
})
