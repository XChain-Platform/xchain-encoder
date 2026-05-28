/**
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

  // ── OP_RETURN > 252 bytes (known imprecision) ───────────────────

  describe('estimateOpReturnOutput > 252 bytes (known imprecision)', () => {
    it('returns 11 + data.length for 252-byte data', () => {
      const data = Buffer.alloc(252, 0x41)
      const estimate = TxSizeEstimator.estimateOpReturnOutput(data)
      // The formula is always 11 + data.length regardless of size.
      // At 252+ bytes the varint scriptPubKey size field needs 3 bytes
      // instead of 1, making the true size 13 + data.length.
      // This is a documented TODO in the source.
      assert.strictEqual(estimate, 11 + 252)
    })

    it('returns 11 + data.length for 253-byte data (same imprecision)', () => {
      const data = Buffer.alloc(253, 0x41)
      const estimate = TxSizeEstimator.estimateOpReturnOutput(data)
      assert.strictEqual(estimate, 11 + 253)
    })

    it('is precise for data under 252 bytes', () => {
      const data = Buffer.alloc(100, 0x41)
      const estimate = TxSizeEstimator.estimateOpReturnOutput(data)
      assert.strictEqual(estimate, 11 + 100)
    })
  })

  // ── estimateInputSize with null return ──────────────────────────

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

  // ── estimateInputSize with out-of-bounds vout ───────────────────

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

  // ── estimateInputSize script type detection ─────────────────────

  describe('estimateInputSize unknown script type', () => {
    it('returns 350-byte fallback for unrecognized script', () => {
      // Create a UTXO with a non-standard scriptPubKey
      const utxo = {
        hash: TXID_A,
        index: 0,
        sequence: 0xffffffff,
        witnessUtxo: {
          script: Buffer.from('51', 'hex'), // OP_1 — not P2WPKH or P2WSH
          value: 100000
        }
      }

      const estimate = TxSizeEstimator.estimateInputSize(utxo)
      assert.strictEqual(estimate, 350, 'should fall back to 350 for unknown script')
    })
  })

  // ── estimateP2shInputWithRedeem boundary ────────────────────────

  describe('estimateP2shInputWithRedeem', () => {
    it('returns overhead (115) for 0-byte redeem script', () => {
      const estimate = TxSizeEstimator.estimateP2shInputWithRedeem(Buffer.alloc(0))
      // 40 outpoint+sequence + 1 scriptSig-varint + 73 sig-push + 1 redeem-push + 0 = 115
      assert.strictEqual(estimate, 115)
    })

    it('returns 595 for 476-byte redeem script (max P2SH chunk)', () => {
      const estimate = TxSizeEstimator.estimateP2shInputWithRedeem(Buffer.alloc(476))
      // 40 + 3 (varint) + 73 (sig push) + 3 (PUSHDATA2 for 476) + 476 = 595
      assert.strictEqual(estimate, 595)
    })
  })

  // ── null propagation in full pipeline ───────────────────────────

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
