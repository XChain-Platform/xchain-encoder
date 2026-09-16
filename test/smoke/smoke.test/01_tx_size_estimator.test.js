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
 * Smoke Tests: xchain-encoder
 *
 * Fast health-check suite that verifies the encoder's core building blocks
 * are operational. No coin node, no network calls, no external services.
 *
 * Run: npm run smoke-test
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib');
const TxSizeEstimator = require('../../../src/build/tx_size_estimator');

describe('S7: TxSizeEstimator', () => {

  it('estimateOpReturnOutput returns positive integer', () => {
    const data = Buffer.from('XCHN test data')
    const size = TxSizeEstimator.estimateOpReturnOutput(data)
    assert.ok(Number.isInteger(size))
    assert.ok(size > 0)
  })

  it('estimateP2shOutput returns positive integer', () => {
    const size = TxSizeEstimator.estimateP2shOutput()
    assert.ok(Number.isInteger(size))
    assert.strictEqual(size, 32)
  })

  it('estimateP2wshOutput returns positive integer', () => {
    const size = TxSizeEstimator.estimateP2wshOutput()
    assert.ok(Number.isInteger(size))
    assert.strictEqual(size, 43)
  })

  it('estimateMultisignOutput returns positive integer', () => {
    // 114 = 8 (value) + 1 (script-length varint) + 105 (compiled 1-of-3 bare
    // multisig). The old 111 here came from a 102-byte script figure that
    // omitted the three push opcodes; 99ebc78 corrected the estimator and this
    // smoke assertion was left on the undercount. The derivation lives in
    // test/unit/tx_size_estimator.test.js, which builds a real p2ms script.
    const size = TxSizeEstimator.estimateMultisignOutput()
    assert.ok(Number.isInteger(size))
    assert.strictEqual(size, 114)
  })
})

describe('S7: TxSizeEstimator', () => {

  it('estimateInputSize: P2WPKH (segwit) is smaller than P2PKH (legacy)', () => {
    const PUBKEY_BUF = Buffer.from(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      'hex'
    )

    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey: PUBKEY_BUF,
      network: bitcoin.networks.regtest
    })
    const segwitInput = {
      hash: 'a'.repeat(64),
      index: 0,
      sequence: 0xffffffff,
      witnessUtxo: { script: p2wpkh.output, value: 100000 }
    }
    const segwitSize = TxSizeEstimator.estimateInputSize(segwitInput)

    const p2pkh = bitcoin.payments.p2pkh({
      pubkey: PUBKEY_BUF,
      network: bitcoin.networks.regtest
    })
    const tx = new bitcoin.Transaction()
    tx.addInput(Buffer.alloc(32, 0x11), 0)
    tx.addOutput(p2pkh.output, 100000)
    const legacyInput = {
      hash: 'a'.repeat(64),
      index: 0,
      sequence: 0xffffffff,
      nonWitnessUtxo: Buffer.from(tx.toHex(), 'hex')
    }
    const legacySize = TxSizeEstimator.estimateInputSize(legacyInput)

    assert.ok(segwitSize < legacySize,
      `Segwit (${segwitSize}) should be smaller than legacy (${legacySize})`)
  })
})
