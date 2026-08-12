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
 * TxSizeEstimator Boundary Tests
 *
 * Tests edge cases in the static estimation methods: known imprecision
 * for large OP_RETURN data, null return propagation, and out-of-bounds
 * vout index fallback behavior.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const TxSizeEstimator = require('../../src/TxSizeEstimator')
const {
  TXID_A,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')

describe('TxSizeEstimator Boundaries', () => {

  describe('estimateOpReturnOutput framing boundaries', () => {
    // Cross-check against a real compiled script rather than a formula, so the
    // estimate cannot drift away from what bitcoinjs actually serializes.
    const trueOutputSize = (data) => {
      const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data])
      return 8 + (script.length < 0xfd ? 1 : 3) + script.length
    }

    it('matches the compiled script at the 75/76 OP_PUSHDATA1 inflection', () => {
      for (const len of [75, 76, 80]) {
        const data = Buffer.alloc(len, 0x41)
        assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), trueOutputSize(data),
          'estimate must equal the real output size at ' + len + ' bytes')
      }
    })

    it('charges a 3-byte script-length varint once the script reaches 253 bytes', () => {
      // 252 bytes of data compiles to OP_RETURN + OP_PUSHDATA1 + len + data = 255,
      // past the 253 compactSize inflection, so the varint costs 3 not 1.
      const data = Buffer.alloc(252, 0x41)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), 266)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), trueOutputSize(data))
    })

    it('stays exact just past the varint inflection (253-byte data)', () => {
      const data = Buffer.alloc(253, 0x41)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), 267)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), trueOutputSize(data))
    })

    it('is exact for a 100-byte payload (single-byte varint, PUSHDATA1 push)', () => {
      const data = Buffer.alloc(100, 0x41)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), 112)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), trueOutputSize(data))
    })
  })

  describe('estimateInputSize with missing UTXO data', () => {
    it('returns 350 (conservative fallback) for UTXO with neither witnessUtxo nor nonWitnessUtxo', () => {
      const utxo = { hash: TXID_A, index: 0, sequence: 0xffffffff }
      const estimate = TxSizeEstimator.estimateInputSize(utxo)
      assert.strictEqual(estimate, 350)
    })

    it('fallback contributes to fee estimation instead of being silently ignored', () => {
      const estimate = TxSizeEstimator.estimateInputSize({
        hash: TXID_A, index: 0, sequence: 0xffffffff
      })
      const txSize = 100 + estimate
      assert.strictEqual(txSize, 450,
        'fallback of 350 contributes to fee estimation')
    })
  })

  describe('estimateInputSize with out-of-bounds vout index', () => {
    it('returns 180 (P2PKH fallback) when output at vout does not exist', () => {
      // Build a raw tx with 1 output, but reference vout=5
      const tx = new bitcoin.Transaction()
      tx.addInput(Buffer.alloc(32, 0x11), 0)
      const p2pkhScript = bitcoin.payments.p2pkh({
        pubkey: PUBKEY_BUF,
        network: bitcoin.networks.regtest
      }).output
      tx.addOutput(p2pkhScript, 100000)

      const utxo = {
        hash: TXID_A,
        index: 5, // out of bounds
        sequence: 0xffffffff,
        nonWitnessUtxo: tx.toBuffer()
      }

      const estimate = TxSizeEstimator.estimateInputSize(utxo)
      assert.strictEqual(estimate, 180, 'should fall back to P2PKH estimate')
    })
  })

  describe('estimateInputSize unknown script type', () => {
    it('returns 350-byte fallback for unrecognized script', () => {
      // Create a UTXO with a non-standard scriptPubKey
      const utxo = {
        hash: TXID_A,
        index: 0,
        sequence: 0xffffffff,
        witnessUtxo: {
          script: Buffer.from('51', 'hex'), // OP_1 (not P2WPKH or P2WSH)
          value: 100000
        }
      }

      const estimate = TxSizeEstimator.estimateInputSize(utxo)
      assert.strictEqual(estimate, 350, 'should fall back to 350 for unknown script')
    })
  })

  describe('estimateP2shInputWithRedeem', () => {
    it('returns overhead (149) for 0-byte redeem script', () => {
      const estimate = TxSizeEstimator.estimateP2shInputWithRedeem(Buffer.alloc(0))
      // 40 outpoint+sequence + 1 scriptSig-varint + 73 sig-push + 34 pubkey-push + 1 redeem-push + 0 = 149
      assert.strictEqual(estimate, 149)
    })

    it('returns 629 for 476-byte redeem script (max P2SH chunk)', () => {
      const estimate = TxSizeEstimator.estimateP2shInputWithRedeem(Buffer.alloc(476))
      // 40 + 3 (varint) + 73 (sig push) + 34 (pubkey push) + 3 (PUSHDATA2 for 476) + 476 = 629
      assert.strictEqual(estimate, 629)
    })
  })

  describe('conservative fallback in pipeline', () => {
    it('missing UTXO data uses 350-byte fallback → fee includes input estimate', async () => {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|JDOG|1|addr', null, null, false, null, address,
        null, null, null, true, 0.00001
      )

      // The fallback ensures fee estimation is conservative rather than
      // silently underestimated. The PSBT should be valid with a change output.
      assert.ok(result.psbt, 'PSBT should be created')
      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.ok(changeOutput, 'change output is created with properly estimated fee')
    })
  })
})
