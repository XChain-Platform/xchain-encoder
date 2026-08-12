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
 * REG-06: P2SH/P2WSH Two-Transaction Sequence
 *
 * Regression sentinel for the fragile tx1→tx2 chaining pattern. tx1 creates
 * funding outputs; tx2 spends them, revealing data in redeemScript (P2SH)
 * or witnessScript (P2WSH). Tests structural chain integrity, ID/hex
 * references, and data fidelity in both variants.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  deobfuscate,
  decompilePayload,
  MAGIC_WORD
} = require('../integration/helpers/deobfuscate')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK_P2SH = 'dogecoin-regtest'
const NETWORK_P2WSH = 'bitcoin-regtest' // P2WSH requires segwit support

function stdUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

/**
 * Create tx1 + tx2 pair for P2SH or P2WSH encoding.
 * NOTE: __CACHE.__TX is a bitcoinjs-lib internal; matches existing test patterns.
 */
async function createTxPair (action, opts = {}) {
  const network = opts.network || NETWORK_P2SH
  const encoding = opts.encoding || null
  const encoder = makeEncoder(network)
  const address = getTestAddress(network)
  const utxo = stdUtxo()

  const tx1 = await encoder.createTransaction(
    [utxo], address, null,
    action.data, action.rawData, 10000, false, encoding, address,
    null, null, null, true, 0.00001
  )

  const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
  const tx1Id = tx1.psbt.__CACHE.__TX.getId()

  const tx2 = await encoder.createTransaction(
    [utxo], address, null,
    action.data, action.rawData, 10000, false, encoding, address,
    tx1Id, tx1Hex, null, true, 0.00001
  )

  return { tx1, tx2, tx1Id, tx1Hex, encoder }
}

describe('REG-06: P2SH/P2WSH Two-Transaction Sequence', function () {

  describe('REG-06.1: P2SH tx1 structure', function () {
    it('tx1 auto-selects P2SH for ISSUE payload', async function () {
      const action = actions.makeIssueFull('REGTEST')
      const { tx1 } = await createTxPair(action)
      assert.strictEqual(tx1.encoding, 'P2SH')
    })

    it('tx1 has P2SH output with value >= dust', async function () {
      const action = actions.makeIssueFull('REGTEST')
      const { tx1, encoder } = await createTxPair(action)

      const p2shOutput = tx1.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160
      })
      assert.ok(p2shOutput, 'tx1 should have P2SH output')
      assert.ok(p2shOutput.value >= encoder.dustAmount)
    })

    it('tx1 has change output', async function () {
      const action = actions.makeIssueFull('REGTEST')
      const { tx1 } = await createTxPair(action)

      const outputs = tx1.psbt.txOutputs
      // Change is the largest non-zero, non-P2SH output
      const changeOutput = outputs.reduce((max, o) =>
        o.value > max.value ? o : max, { value: 0 })
      assert.ok(changeOutput.value > 0, 'should have a change output')
    })
  })

  describe('REG-06.2: P2SH tx2 structure', function () {
    it('tx2 has P2SH input with redeemScript', async function () {
      const action = actions.makeIssueFull('REGTEST')
      const { tx2 } = await createTxPair(action)

      assert.strictEqual(tx2.encoding, 'P2SH')
      const input = tx2.psbt.data.inputs[0]
      assert.ok(input.redeemScript, 'tx2 input should have redeemScript')
    })

    it('redeemScript has [data] OP_DROP OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG', async function () {
      const action = actions.makeIssueFull('REGTEST')
      const { tx2 } = await createTxPair(action)

      const input = tx2.psbt.data.inputs[0]
      const d = bitcoin.script.decompile(input.redeemScript)
      assert.ok(Buffer.isBuffer(d[0]), 'first element should be data buffer')
      assert.strictEqual(d[1], bitcoin.opcodes.OP_DROP)
      assert.strictEqual(d[2], bitcoin.opcodes.OP_DUP)
      assert.strictEqual(d[3], bitcoin.opcodes.OP_HASH160)
      assert.ok(Buffer.isBuffer(d[4]) && d[4].length === 20, 'pubkey hash 20 bytes')
      assert.strictEqual(d[5], bitcoin.opcodes.OP_EQUALVERIFY)
      assert.strictEqual(d[6], bitcoin.opcodes.OP_CHECKSIG)
    })

    it('tx2 has OP_RETURN marker output (value=0)', async function () {
      const action = actions.makeIssueFull('REGTEST')
      const { tx2 } = await createTxPair(action)

      const marker = tx2.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(marker, 'tx2 should have OP_RETURN marker')
      assert.strictEqual(marker.script[0], bitcoin.opcodes.OP_RETURN)
    })
  })

  describe('REG-06.3: P2SH chaining integrity', function () {
    it('tx2 first input hash references tx1 ID', async function () {
      const action = actions.makeIssueFull('CHAIN')
      const { tx2, tx1Id } = await createTxPair(action)

      const inputHash = tx2.psbt.txInputs[0].hash.reverse().toString('hex')
      assert.strictEqual(inputHash, tx1Id)
    })

    it('tx2 input nonWitnessUtxo matches tx1 raw hex', async function () {
      const action = actions.makeIssueFull('HEXREF')
      const { tx2, tx1Hex } = await createTxPair(action)

      const input = tx2.psbt.data.inputs[0]
      assert.ok(input.nonWitnessUtxo, 'should have nonWitnessUtxo')
      assert.strictEqual(input.nonWitnessUtxo.toString('hex'), tx1Hex)
    })

    it('tx2 OP_RETURN marker deobfuscates to XCHNp2sh using tx1Id', async function () {
      const action = actions.makeIssueFull('MARKER')
      const { tx2, tx1Id } = await createTxPair(action)

      const marker = tx2.psbt.txOutputs.find(o => o.value === 0)
      const d = bitcoin.script.decompile(marker.script)
      const decrypted = deobfuscate(d[1], tx1Id)
      assert.strictEqual(decrypted.toString('utf8'), 'XCHNp2sh')
    })
  })

  describe('REG-06.4: P2SH data fidelity', function () {
    it('redeemScript data chunk decompiles back to original ACTION string', async function () {
      const action = actions.makeIssueFull('FIDELITY')
      const { tx2 } = await createTxPair(action)

      const input = tx2.psbt.data.inputs[0]
      const d = bitcoin.script.decompile(input.redeemScript)
      const dataChunk = d[0]
      const innerDecompiled = decompilePayload(dataChunk)
      assert.strictEqual(innerDecompiled[0].toString('utf8'), action.data)
    })
  })

  describe('REG-06.5: P2WSH tx1 structure', function () {
    it('tx1 creates P2WSH output (OP_0 <32-byte-hash>)', async function () {
      const action = actions.makeFileLarge()
      const { tx1 } = await createTxPair(action, {
        encoding: 'P2WSH',
        network: NETWORK_P2WSH
      })

      assert.strictEqual(tx1.encoding, 'P2WSH')

      const p2wshOutput = tx1.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_0 &&
               Buffer.isBuffer(d[1]) && d[1].length === 32
      })
      assert.ok(p2wshOutput, 'tx1 should have P2WSH output')
    })
  })

  describe('REG-06.6: P2WSH tx2 structure', function () {
    it('tx2 has witnessScript in input', async function () {
      const action = actions.makeFileLarge()
      const { tx2 } = await createTxPair(action, {
        encoding: 'P2WSH',
        network: NETWORK_P2WSH
      })

      assert.strictEqual(tx2.encoding, 'P2WSH')
      const input = tx2.psbt.data.inputs[0]
      assert.ok(input.witnessScript, 'tx2 input should have witnessScript')
    })

    it('witnessScript starts with [data] OP_DROP', async function () {
      const action = actions.makeFileLarge()
      const { tx2 } = await createTxPair(action, {
        encoding: 'P2WSH',
        network: NETWORK_P2WSH
      })

      const input = tx2.psbt.data.inputs[0]
      const d = bitcoin.script.decompile(input.witnessScript)
      assert.ok(Buffer.isBuffer(d[0]))
      assert.strictEqual(d[1], bitcoin.opcodes.OP_DROP)
    })

    it('tx2 OP_RETURN marker deobfuscates to XCHNp2wsh', async function () {
      const action = actions.makeFileLarge()
      const { tx2, tx1Id } = await createTxPair(action, {
        encoding: 'P2WSH',
        network: NETWORK_P2WSH
      })

      const marker = tx2.psbt.txOutputs.find(o => o.value === 0)
      const d = bitcoin.script.decompile(marker.script)
      const decrypted = deobfuscate(d[1], tx1Id)
      assert.strictEqual(decrypted.toString('utf8'), 'XCHNp2wsh')
    })
  })

  describe('REG-06.7: P2WSH data fidelity', function () {
    it('witnessScript data chunks reassemble to the original ACTION string', async function () {
      const action = actions.makeFileLarge()
      const { tx2 } = await createTxPair(action, {
        encoding: 'P2WSH',
        network: NETWORK_P2WSH
      })

      // Each reveal input carries one raw data chunk as the first witnessScript
      // element. makeFileLarge exceeds one 476-byte chunk, so the compiled
      // ACTION script is split across multiple inputs; concatenate the chunks in
      // order to recover the full compiled payload before decompiling. (Taking a
      // single chunk would decompile a truncated script and return null.)
      const fullCompiled = Buffer.concat(
        tx2.psbt.data.inputs
          .filter(input => input.witnessScript)
          .map(input => bitcoin.script.decompile(input.witnessScript)[0])
      )
      const innerDecompiled = decompilePayload(fullCompiled)
      assert.strictEqual(innerDecompiled[0].toString('utf8'), action.data)
    })
  })

  // A P2WSH reveal that spends a single data chunk is just 1 input + 1
  // OP_RETURN marker = 71 stripped (non-witness) bytes, because the payload
  // lives in the witness and does not count toward stripped size. BOTH chains
  // reject that as "tx-size-small": Litecoin's floor is 85 and Bitcoin Core's
  // MIN_STANDARD_TX_NONWITNESS_SIZE is 82. (This block previously asserted
  // Bitcoin relayed it, on the strength of the 65 that coins/BTC.js carried;
  // 65 is the CONSENSUS minimum guarding the 64-byte-transaction CVE, which no
  // relay enforces alone; measured live on BTC regtest, 71 is rejected and
  // 82 is accepted.) The encoder must pad the reveal over the target chain's
  // minStandardTxNonWitnessSize on every chain. Both the minimum (75) and
  // maximum (476) single-chunk compiled-payload sizes must clear the floor.

  describe('REG-06.8: P2WSH single-chunk stripped-size floor', function () {

    async function buildSingleChunkReveal (network, compiledTarget) {
      // makeActionOfSize(N) returns a raw N-byte ACTION string; script.compile
      // prepends the push opcode/length, so compiled = N+1 for N<76 and N+3 for
      // N>=256. Hence compiled 75 ⇒ raw 74, compiled 476 ⇒ raw 473.
      const rawLen = compiledTarget < 256 ? compiledTarget - 1 : compiledTarget - 3
      const action = actions.makeActionOfSize(rawLen)
      const compiled = bitcoin.script.compile([Buffer.from(action.data, 'utf8')]).length
      assert.strictEqual(compiled, compiledTarget,
        `compiled payload should be exactly ${compiledTarget} bytes (single chunk)`)

      const encoder = makeEncoder(network)
      const address = getTestAddress(network)
      const utxo = stdUtxo()

      const tx1 = await encoder.createTransaction(
        [utxo], address, null, action.data, action.rawData, null, false, 'P2WSH', address,
        null, null, null, true, 0.00001)
      const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1.psbt.__CACHE.__TX.getId()

      const tx2 = await encoder.createTransaction(
        [utxo], address, null, action.data, action.rawData, null, false, 'P2WSH', address,
        tx1Id, tx1Hex, null, true, 0.00001)

      // A single compiled chunk must produce exactly one P2WSH reveal input.
      assert.strictEqual(tx2.psbt.txInputs.length, 1,
        'single-chunk reveal should have exactly one input')
      return { tx2, encoder }
    }

    for (const compiled of [75, 476]) {
      it(`Litecoin reveal (compiled ${compiled}B) clears the tx-size-small floor`, async function () {
        const { tx2, encoder } = await buildSingleChunkReveal('litecoin-regtest', compiled)
        const floor = encoder.network.minStandardTxNonWitnessSize
        assert.strictEqual(floor, 85, 'litecoin floor should be 85')
        // byteLength(false) = stripped (non-witness) serialization: the size a
        // node measures against MIN_STANDARD_TX_NONWITNESS_SIZE.
        const stripped = tx2.psbt.__CACHE.__TX.byteLength(false)
        assert.ok(stripped >= floor,
          `stripped size ${stripped} must be >= litecoin floor ${floor}`)
      })
    }

    for (const compiled of [75, 476]) {
      it(`Bitcoin reveal (compiled ${compiled}B) clears the tx-size-small floor`, async function () {
        const { tx2, encoder } = await buildSingleChunkReveal('bitcoin-regtest', compiled)
        const floor = encoder.network.minStandardTxNonWitnessSize
        assert.strictEqual(floor, 82, 'bitcoin floor should be the 82-byte POLICY floor, not the 65-byte consensus one')
        const stripped = tx2.psbt.__CACHE.__TX.byteLength(false)
        assert.ok(stripped >= floor,
          `stripped size ${stripped} must be >= bitcoin floor ${floor}`)
        // The unpadded shape is 71 bytes and one output; padding is the whole
        // point, so assert the pad output exists rather than only the size.
        assert.strictEqual(tx2.psbt.txOutputs.length, 2,
          'bitcoin reveal carries the OP_RETURN marker plus one size-padding output')
      })
    }
  })
})
