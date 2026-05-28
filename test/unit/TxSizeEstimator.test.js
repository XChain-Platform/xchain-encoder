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
    //   scriptSig = 73 (1-byte opcode + 72-byte sig) + redeemPush + redeem
    //   redeemPush = 1  (<76 bytes), 2 (76..255), or 3 (256..65535)
    //   scriptSig-varint = 1 if scriptSig <253, else 3

    it('returns 115 for empty redeem (scriptSig=74, varint=1)', () => {
      const redeem = Buffer.alloc(0)
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 115)
    })

    it('returns 595 for 476-byte redeem (PUSHDATA2, varint=3)', () => {
      const redeem = Buffer.alloc(476)
      // 40 + 3 + (73 + 3 + 476) = 40 + 3 + 552 = 595
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 595)
    })

    it('returns 116 for a 1-byte redeem script', () => {
      const redeem = Buffer.from([0x01])
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 116)
    })

    it('uses OP_PUSHDATA1 (2-byte push) at redeem 76 bytes', () => {
      const redeem = Buffer.alloc(76)
      // 40 + 1 + (73 + 2 + 76) = 40 + 1 + 151 = 192
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 192)
    })

    it('uses OP_PUSHDATA2 (3-byte push) at redeem 256 bytes', () => {
      const redeem = Buffer.alloc(256)
      // scriptSig = 73 + 3 + 256 = 332 → scriptSig-varint = 3
      // 40 + 3 + 332 = 375
      assert.strictEqual(TxSizeEstimator.estimateP2shInputWithRedeem(redeem), 375)
    })

    it('uses 3-byte scriptSig varint when total scriptSig >= 253', () => {
      // 178-byte redeem → scriptSig = 73 + 2 + 178 = 253 → varint widens to 3
      const redeem = Buffer.alloc(178)
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
  })
})
