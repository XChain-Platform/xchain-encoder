// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
  assert,
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  LTC_REGTEST,
  TxSizeEstimator,
  TEST_ADDRESS
} = require('./fixtures/transaction')

// On native-fee chains a real FEE_DESTINATION rides as a customOutputs entry.
// The indexer treats the P2SH REVEAL (phase 2) as the action and reads the fee
// output from it, so the fee output must land on the reveal, never on the
// funding tx. But the reveal's only inputs are the funding outputs, so the
// funding tx must over-fund by the fee value (without emitting the output) or
// the reveal cannot pay it. These tests pin both halves of that contract.
const FEE_VALUE = 10678 // a representative native-fee output value (sats/koinu)
const bigData = 'x'.repeat(80) // exceeds OP_RETURN limit, forces P2SH

function feeOutputs () {
  return [{ address: TEST_ADDRESS, value: FEE_VALUE }]
}

// Find the P2SH funding output (a positive-value output that is not the change).
// Change equals input minus everything else and is by far the largest output.
function findFundingOutput (psbt) {
  const positive = psbt.txOutputs.filter(o => o.value > 0)
  positive.sort((a, b) => a.value - b.value)
  return positive[0]
}

describe('XChainEncoder.createTransaction()', () => {
  describe('P2SH native-fee customOutputs', () => {
    it('phase 1 (funding) does NOT emit the fee-destination output', async () => {
      const encoder = makeEncoder()
      encoder.dustAmount = 546
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, feeOutputs(),
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
      // The P2SH funding tx is just [P2SH funding output, change] (the OP_RETURN
      // marker rides the reveal, not the funding tx). No fee-destination output
      // is emitted here: a standalone output worth exactly FEE_VALUE would mean
      // the fee was put on the wrong tx and later double-paid on the reveal.
      const emittedFee = result.psbt.txOutputs.find(o => o.value === FEE_VALUE)
      assert.ok(!emittedFee, 'funding tx must not emit a standalone fee-destination output')
      assert.strictEqual(result.psbt.txOutputs.length, 2,
        'funding tx must be [P2SH funding output, change] only')
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('P2SH native-fee customOutputs', () => {
    it('phase 1 (funding) over-funds the P2SH output by the fee value plus its byte cost', async () => {
      const encoder = makeEncoder()
      // Pin both floors: the reveal's change headroom keys on outputFloor, the fee
      // floor on dustAmount, and the delta below assumes one value for each.
      encoder.dustAmount = 546
      encoder.outputFloor = 546
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Baseline funding output value with no customOutputs.
      const base = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )
      const baseFunding = findFundingOutput(base.psbt).value

      // Same call but with the fee customOutput: the funding output must grow by
      // FEE_VALUE so the reveal can pay the fee, plus the reveal's own miner
      // fee for the bytes that output adds to the reveal. Without the second
      // term the reveal lands under the node's min-relay floor.
      //
      // It grows by one dust LESS than that, and the difference is the point.
      // The baseline reveal emits no value output of its own, so its funding
      // must also carry a dust for the change output that keeps it from burning
      // every satoshi to miners. A reveal already carrying a
      // fee output leaves value by definition and needs no change output, so
      // funding that dust too would buy the caller a third output they never
      // asked for - which is what REG-14 pins against on this exact shape.
      //
      // Same input as the baseline on purpose: release its reservation first.
      encoder.clearReservations()
      const withFee = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, feeOutputs(),
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )
      const feeFunding = findFundingOutput(withFee.psbt).value

      // Same conversion the encoder applies: feePerKb -> internal coin/byte.
      const feePerBytes = 0.00001 / 1000 / 1e8
      const feeOutputBytes = TxSizeEstimator.estimateOutputSizeForAddress(TEST_ADDRESS, LTC_REGTEST)
      const revealByteFee = Math.ceil(feeOutputBytes * feePerBytes * 1e8)

      assert.strictEqual(feeFunding - baseFunding, FEE_VALUE + revealByteFee - encoder.outputFloor,
        'funding output must grow by the fee value plus the fee output byte cost, ' +
        'less the change headroom (one output floor) only the outputless baseline needs')
    })
  })
})

describe('XChainEncoder.createTransaction()', () => {
  describe('P2SH native-fee customOutputs', () => {
    it('phase 2 (reveal) emits the fee-destination output funded by phase 1', async () => {
      const encoder = makeEncoder()
      encoder.dustAmount = 546
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Build phase 1 (funding) with the fee customOutput.
      const tx1 = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, feeOutputs(),
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )
      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      // Build phase 2 (reveal) spending phase 1, with the same fee customOutput.
      const tx2 = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, feeOutputs(),
        bigData, null, 10000, false, null, TEST_ADDRESS,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      assert.strictEqual(tx2.encoding, 'P2SH')
      // The reveal must carry the fee-destination output (value FEE_VALUE).
      const feeOut = tx2.psbt.txOutputs.find(o => o.value === FEE_VALUE)
      assert.ok(feeOut, 'reveal must emit the fee-destination output')

      // And it is not a bare OP_RETURN-only tx (the fee-drop failure mode).
      const opReturnOnly = tx2.psbt.txOutputs.every(o => o.value === 0)
      assert.ok(!opReturnOnly, 'reveal must not be OP_RETURN-only')

      // The reveal's input value (the funded P2SH output) must cover the fee
      // output so bitcoinjs does not reject it as outputs-exceed-inputs.
      const fundingOut = findFundingOutput(tx1.psbt)
      assert.ok(fundingOut.value >= FEE_VALUE,
        'phase-1 funding output must cover the reveal fee output')
    })
  })
})
