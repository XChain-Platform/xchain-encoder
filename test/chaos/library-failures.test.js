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
 * Chaos Engineering: Category C: Library & Crypto Failures
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

  // No monkey-patching needed; uses the real encoder.
  //
  // Both cases were written when resolveCallerHash160 was a bare
  // fromBase58Check, so ANY non-base58 identity crashed with "Non-base58
  // character". The resolver now accepts every identity form a client
  // legitimately sends (raw pubkey hex, v0 bech32 P2WPKH) because the P2SH
  // chunk-lane gate needs the same 20 bytes whichever form arrives, and every
  // wallet flow sends a raw pubkey. So a bech32 caller is no longer an error,
  // and the remaining error is a specific, named refusal rather than a library
  // crash. The chaos value is in that split: what resolves, and what does not.

  describe('C-5: Non-base58 caller identity for P2SH encoding', () => {
    it('bech32 P2WPKH caller resolves to the same HASH160 as the raw pubkey', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const bech32Addr = bitcoin.payments.p2wpkh({
        pubkey: PUBKEY_BUF,
        network: bitcoin.networks.regtest
      }).address

      const viaBech32 = await encoder.createTransaction(
        [utxo], bech32Addr, null,
        actions.makeIssueFull().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )
      // Same input on purpose: release the first build's reservation.
      encoder.clearReservations()
      const viaPubkey = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], PUBKEY_BUF.toString('hex'), null,
        actions.makeIssueFull().data, null, 10000, false, null, DOGE_ADDR,
        null, null, null, true, 0.00001
      )

      // The witness program IS HASH160(pubkey), so the two identities must
      // produce byte-identical P2SH outputs. Comparing the built scripts is
      // what proves the resolver agreed, rather than merely not throwing.
      assert.deepStrictEqual(
        viaBech32.psbt.txOutputs.map(o => o.script.toString('hex')),
        viaPubkey.psbt.txOutputs.map(o => o.script.toString('hex')))
    })

    it('an identity that is no address and no pubkey is refused by name', async () => {
      const encoder = makeEncoder(DOGE)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], 'deadbeefdeadbeef', null,
          actions.makeIssueFull().data, null, 10000, false, null, DOGE_ADDR,
          null, null, null, true, 0.00001
        ),
        /cannot resolve a 20-byte caller HASH160/i
      )
    })
  })
})
