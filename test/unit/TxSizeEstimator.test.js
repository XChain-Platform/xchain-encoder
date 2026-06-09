// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const TxSizeEstimator = require('../../src/TxSizeEstimator')

describe('TxSizeEstimator', () => {

  describe('.estimateOpReturnOutput(data)', () => {
    it('returns 11 + data.length for empty data', () => {
      const data = Buffer.alloc(0)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), 11)
    })

    it('returns 11 + data.length for 76-byte data', () => {
      const data = Buffer.alloc(76)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), 87)
    })

    it('returns 11 + data.length for 80-byte data', () => {
      const data = Buffer.alloc(80)
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), 91)
    })

    it('returns 12 for a 1-byte buffer', () => {
      const data = Buffer.from([0x42])
      assert.strictEqual(TxSizeEstimator.estimateOpReturnOutput(data), 12)
    })
  })

  describe('.estimateP2shOutput()', () => {
    it('always returns 32', () => {
      assert.strictEqual(TxSizeEstimator.estimateP2shOutput(), 32)
    })
  })

  describe('.estimateP2wshOutput()', () => {
    it('always returns 43', () => {
      assert.strictEqual(TxSizeEstimator.estimateP2wshOutput(), 43)
    })
  })

  describe('.estimateMultisignOutput()', () => {
    it('always returns 111', () => {
      assert.strictEqual(TxSizeEstimator.estimateMultisignOutput(), 111)
    })
  })

  describe('.estimateP2shInputWithRedeem(redeemData)', () => {
    // Estimate breakdown:
    //   40 outpoint+sequence + scriptSig-varint + scriptSig
    //   scriptSig = 73 (1-byte opcode + 72-byte sig)
    //             + 34 (1-byte opcode + 33-byte compressed pubkey)
    //             + redeemPush + redeem
    //   redeemPush = 1  (<76 bytes), 2 (76..255), or 3 (256..65535)
    //   scriptSig-varint = 1 if scriptSig <253, else 3
    // (The reveal scriptSig pushes sig, pubkey, then the redeem script — the
    //  pubkey push was previously omitted, undercounting every estimate by 34.)

    it('returns 149 for empty redeem (scriptSig=108, varint=1)', () => {
      const redeem = Buffer.alloc(0)
      // 40 + 1 + (73 + 34 + 1 + 0) = 40 + 1 + 108 = 149
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 149)
    })

    it('returns 629 for 476-byte redeem (PUSHDATA2, varint=3)', () => {
      const redeem = Buffer.alloc(476)
      // 40 + 3 + (73 + 34 + 3 + 476) = 40 + 3 + 586 = 629
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 629)
    })

    it('returns 150 for a 1-byte redeem script', () => {
      const redeem = Buffer.from([0x01])
      // 40 + 1 + (73 + 34 + 1 + 1) = 40 + 1 + 109 = 150
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 150)
    })

    it('uses OP_PUSHDATA1 (2-byte push) at redeem 76 bytes', () => {
      const redeem = Buffer.alloc(76)
      // 40 + 1 + (73 + 34 + 2 + 76) = 40 + 1 + 185 = 226
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 226)
    })

    it('uses OP_PUSHDATA2 (3-byte push) at redeem 256 bytes', () => {
      const redeem = Buffer.alloc(256)
      // scriptSig = 73 + 34 + 3 + 256 = 366 → scriptSig-varint = 3
      // 40 + 3 + 366 = 409
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 409)
    })

    it('uses 3-byte scriptSig varint when total scriptSig >= 253', () => {
      // 144-byte redeem → scriptSig = 73 + 34 + 2 + 144 = 253 → varint widens to 3
      const redeem = Buffer.alloc(144)
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 40 + 3 + 253)
    })
  })

  describe('.estimateInputSize(utxo)', () => {

    describe('SegWit inputs (witnessUtxo)', () => {
      it('returns 68 for P2WPKH (0014 prefix)', () => {
        // P2WPKH scriptPubKey: OP_0 <20-byte-hash>
        const hash = Buffer.alloc(20, 0xab)
        const script = Buffer.concat([Buffer.from('0014', 'hex'), hash])
        const utxo = {
          hash: Buffer.alloc(32),
          index: 0,
          sequence: 0xffffffff,
          witnessUtxo: { script, value: 100000 }
        }
        assert.strictEqual(TxSizeEstimator.estimateInputSize(utxo), 68)
      })

      it('returns 105 for P2WSH (0020 prefix)', () => {
        // P2WSH scriptPubKey: OP_0 <32-byte-hash>
        const hash = Buffer.alloc(32, 0xcd)
        const script = Buffer.concat([Buffer.from('0020', 'hex'), hash])
        const utxo = {
          hash: Buffer.alloc(32),
          index: 0,
          sequence: 0xffffffff,
          witnessUtxo: { script, value: 100000 }
        }
        assert.strictEqual(TxSizeEstimator.estimateInputSize(utxo), 105)
      })

      it('returns 350 (fallback) for unknown segwit script', () => {
        // A segwit script that is neither P2WPKH nor P2WSH
        const script = Buffer.from('0051', 'hex')
        const utxo = {
          hash: Buffer.alloc(32),
          index: 0,
          sequence: 0xffffffff,
          witnessUtxo: { script, value: 100000 }
        }
        assert.strictEqual(TxSizeEstimator.estimateInputSize(utxo), 350)
      })
    })

    describe('Legacy inputs (nonWitnessUtxo)', () => {
      it('returns 180 for P2PKH nonWitnessUtxo', () => {
        const tx = new bitcoin.Transaction()
        tx.addInput(Buffer.alloc(32), 0)
        // P2PKH output: OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG
        const p2pkhScript = Buffer.from(
          '76a914' + 'ab'.repeat(20) + '88ac', 'hex'
        )
        tx.addOutput(p2pkhScript, 100000)

        const utxo = {
          hash: Buffer.alloc(32),
          index: 0,
          sequence: 0xffffffff,
          nonWitnessUtxo: tx.toBuffer()
        }

        assert.strictEqual(TxSizeEstimator.estimateInputSize(utxo), 180)
      })

      it('returns 289 for P2SH nonWitnessUtxo', () => {
        const tx = new bitcoin.Transaction()
        tx.addInput(Buffer.alloc(32), 0)
        // P2SH output: OP_HASH160 <hash> OP_EQUAL
        const p2shScript = Buffer.from(
          'a914' + 'ab'.repeat(20) + '87', 'hex'
        )
        tx.addOutput(p2shScript, 100000)

        const utxo = {
          hash: Buffer.alloc(32),
          index: 0,
          sequence: 0xffffffff,
          nonWitnessUtxo: tx.toBuffer()
        }

        assert.strictEqual(TxSizeEstimator.estimateInputSize(utxo), 289)
      })
    })

    describe('No witnessUtxo or nonWitnessUtxo', () => {
      it('returns 350 (conservative fallback)', () => {
        const utxo = {
          hash: Buffer.alloc(32),
          index: 0,
          sequence: 0xffffffff
        }
        assert.strictEqual(TxSizeEstimator.estimateInputSize(utxo), 350)
      })
    })

    describe('nonWitnessUtxo edge cases', () => {
      it('returns 350 when the nonWitnessUtxo buffer cannot be decoded', () => {
        const utxo = { nonWitnessUtxo: Buffer.from([0x00, 0x01]), index: 0 }
        assert.strictEqual(TxSizeEstimator.estimateInputSize(utxo), 350)
      })
      it('returns 180 (assume P2PKH) when the referenced output index is missing', () => {
        const tx = new bitcoin.Transaction()
        tx.addInput(Buffer.alloc(32), 0)
        tx.addOutput(Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex'), 1000)
        const utxo = { nonWitnessUtxo: tx.toBuffer(), index: 5 } // past the single output
        assert.strictEqual(TxSizeEstimator.estimateInputSize(utxo), 180)
      })
    })
  })
})
