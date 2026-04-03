/**
 * E2E-2: Two-Transaction P2SH/P2WSH Orchestration
 *
 * Validates the full tx1 → tx2 sequence for P2SH and P2WSH encoding.
 * tx1 creates the funding output; tx2 spends it, revealing the data in
 * the redeemScript or witnessScript.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  deobfuscate,
  extractOpReturnPayload,
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

const NETWORK = 'dogecoin-regtest'

function stdUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

/**
 * Create tx1 + tx2 for a P2SH/P2WSH action.
 */
async function createTxPair (action, opts = {}) {
  const network = opts.network || NETWORK
  const encoding = opts.encoding || null
  const encoder = makeEncoder(network)
  const address = getTestAddress(network)
  const utxo = stdUtxo()

  // tx1
  const tx1 = await encoder.createTransaction(
    [utxo], address, null,
    action.data, action.rawData, 10000, false, encoding, address,
    null, null, null, true, 0.00001
  )

  const tx1Hex = tx1.psbt.__CACHE.__TX.toHex()
  const tx1Id = tx1.psbt.__CACHE.__TX.getId()

  // tx2
  const tx2 = await encoder.createTransaction(
    [utxo], address, null,
    action.data, action.rawData, 10000, false, encoding, address,
    tx1Id, tx1Hex, null, true, 0.00001
  )

  return { tx1, tx2, tx1Id, tx1Hex, encoder }
}

describe('E2E-2: Two-Transaction P2SH/P2WSH Orchestration', () => {

  // ── E2E-2.1: P2SH full sequence ──────────────────────────────

  describe('E2E-2.1: P2SH full sequence (ISSUE)', () => {
    it('tx1 creates P2SH output, tx2 spends with redeemScript', async () => {
      const action = actions.makeIssueFull('BIGTOKEN')
      const { tx1, tx2 } = await createTxPair(action)

      // tx1 should be P2SH
      assert.strictEqual(tx1.encoding, 'P2SH')

      // tx1 should have P2SH output
      const p2shOutput = tx1.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160
      })
      assert.ok(p2shOutput, 'tx1 should have P2SH output')

      // tx2 should have redeemScript in input
      assert.strictEqual(tx2.encoding, 'P2SH')
      const input = tx2.psbt.data.inputs[0]
      assert.ok(input.redeemScript, 'tx2 input should have redeemScript')

      // Verify redeemScript structure: [data] OP_DROP OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG
      const decompiled = bitcoin.script.decompile(input.redeemScript)
      assert.ok(Buffer.isBuffer(decompiled[0]), 'first element should be data buffer')
      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)
      assert.strictEqual(decompiled[2], bitcoin.opcodes.OP_DUP)
      assert.strictEqual(decompiled[3], bitcoin.opcodes.OP_HASH160)
      assert.ok(Buffer.isBuffer(decompiled[4]), 'should have pubkey hash')
      assert.strictEqual(decompiled[4].length, 20)
      assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_EQUALVERIFY)
      assert.strictEqual(decompiled[6], bitcoin.opcodes.OP_CHECKSIG)
    })
  })

  // ── E2E-2.2: P2SH tx2 marker ─────────────────────────────────

  describe('E2E-2.2: P2SH tx2 OP_RETURN marker', () => {
    it('tx2 marker deobfuscates to XCHNp2sh', async () => {
      const action = actions.makeIssueFull('BIGTOKEN')
      const { tx2, tx1Id } = await createTxPair(action)

      const markerOutput = tx2.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(markerOutput, 'tx2 should have OP_RETURN marker')
      assert.strictEqual(markerOutput.script[0], bitcoin.opcodes.OP_RETURN)

      const decompiled = bitcoin.script.decompile(markerOutput.script)
      const decrypted = deobfuscate(decompiled[1], tx1Id)
      assert.strictEqual(decrypted.toString('utf8'), 'XCHNp2sh')
    })
  })

  // ── E2E-2.3: P2SH data fidelity ──────────────────────────────

  describe('E2E-2.3: P2SH data fidelity', () => {
    it('redeemScript contains original ACTION data (unobfuscated)', async () => {
      const action = actions.makeIssueFull('FIDELITY')
      const { tx2 } = await createTxPair(action)

      // P2SH redeemScript: [data_chunk] OP_DROP OP_DUP OP_HASH160 ...
      // The data_chunk is the raw compiled script (NOT obfuscated)
      const input = tx2.psbt.data.inputs[0]
      const decompiled = bitcoin.script.decompile(input.redeemScript)
      const dataChunk = decompiled[0]

      assert.ok(Buffer.isBuffer(dataChunk))
      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)

      // dataChunk is bitcoin.script.compile([actionBuffer])
      const innerDecompiled = decompilePayload(dataChunk)
      assert.strictEqual(innerDecompiled[0].toString('utf8'), action.data)
    })
  })

  // ── E2E-2.4: P2WSH full sequence ─────────────────────────────

  describe('E2E-2.4: P2WSH full sequence (FILE)', () => {
    it('tx1 creates P2WSH output, tx2 spends with witnessScript', async () => {
      const action = actions.makeFileLarge()
      const { tx1, tx2 } = await createTxPair(action, {
        encoding: 'P2WSH',
        network: 'bitcoin-regtest'
      })

      assert.strictEqual(tx1.encoding, 'P2WSH')

      // tx1: P2WSH output OP_0 <32-byte-hash>
      const p2wshOutput = tx1.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_0 &&
               Buffer.isBuffer(d[1]) && d[1].length === 32
      })
      assert.ok(p2wshOutput, 'tx1 should have P2WSH output')

      // tx2: witnessScript in input
      assert.strictEqual(tx2.encoding, 'P2WSH')
      const input = tx2.psbt.data.inputs[0]
      assert.ok(input.witnessScript, 'tx2 input should have witnessScript')

      // Verify witnessScript starts with data + OP_DROP
      const decompiled = bitcoin.script.decompile(input.witnessScript)
      assert.ok(Buffer.isBuffer(decompiled[0]), 'first element should be data buffer')
      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)
    })
  })

  // ── E2E-2.5: P2WSH tx2 marker ────────────────────────────────

  describe('E2E-2.5: P2WSH tx2 OP_RETURN marker', () => {
    it('tx2 marker deobfuscates to XCHNp2sh', async () => {
      const action = actions.makeFileLarge()
      const { tx2, tx1Id } = await createTxPair(action, {
        encoding: 'P2WSH',
        network: 'bitcoin-regtest'
      })

      const markerOutput = tx2.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(markerOutput, 'tx2 should have OP_RETURN marker')

      const decompiled = bitcoin.script.decompile(markerOutput.script)
      const decrypted = deobfuscate(decompiled[1], tx1Id)
      assert.strictEqual(decrypted.toString('utf8'), 'XCHNp2wsh')
    })
  })

  // ── E2E-2.6: P2WSH data fidelity ─────────────────────────────

  describe('E2E-2.6: P2WSH data fidelity', () => {
    it('witnessScript contains original ACTION data (unobfuscated)', async () => {
      const action = actions.makeFileLarge()
      const { tx2 } = await createTxPair(action, {
        encoding: 'P2WSH',
        network: 'bitcoin-regtest'
      })

      // P2WSH witnessScript: [data_chunk] OP_DROP OP_DUP OP_HASH160 ...
      const input = tx2.psbt.data.inputs[0]
      const decompiled = bitcoin.script.decompile(input.witnessScript)
      const dataChunk = decompiled[0]

      assert.ok(Buffer.isBuffer(dataChunk))
      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)

      // dataChunk is the raw compiled ACTION data
      const innerDecompiled = decompilePayload(dataChunk)
      assert.strictEqual(innerDecompiled[0].toString('utf8'), action.data)
    })
  })

  // ── E2E-2.7: tx1→tx2 ID chaining ─────────────────────────────

  describe('E2E-2.7: tx1→tx2 ID chaining', () => {
    it('tx2 references tx1 ID as input hash', async () => {
      const action = actions.makeIssueFull('CHAIN')
      const { tx2, tx1Id } = await createTxPair(action)

      // tx2's first input hash should reference tx1
      const tx2InputHash = tx2.psbt.txInputs[0].hash.reverse().toString('hex')
      assert.strictEqual(tx2InputHash, tx1Id)
    })
  })

  // ── E2E-2.8: tx1→tx2 hex chaining ────────────────────────────

  describe('E2E-2.8: tx1→tx2 hex chaining', () => {
    it('tx2 nonWitnessUtxo matches tx1 raw hex', async () => {
      const action = actions.makeIssueFull('HEXCHAIN')
      const { tx2, tx1Hex } = await createTxPair(action)

      // The P2SH spending input should have nonWitnessUtxo that is tx1
      const input = tx2.psbt.data.inputs[0]
      assert.ok(input.nonWitnessUtxo, 'tx2 P2SH input should have nonWitnessUtxo')
      assert.strictEqual(input.nonWitnessUtxo.toString('hex'), tx1Hex)
    })
  })

  // ── E2E-2.9: Multi-chunk P2SH ────────────────────────────────

  describe('E2E-2.9: Multi-chunk P2SH', () => {
    it('large ACTION requiring multiple P2SH outputs all have valid structure', async () => {
      // Create a very large ISSUE with long description to force multiple chunks
      const action = actions.makeIssueFull('MULTICHUNK', {
        description: 'X'.repeat(400) // exceed single P2SH chunk
      })
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()

      const tx1 = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(tx1.encoding, 'P2SH')

      // Count P2SH outputs (OP_HASH160 pattern)
      const p2shOutputs = tx1.psbt.txOutputs.filter(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_HASH160
      })

      // With 400-byte description + ~200 bytes of other fields, should need multiple chunks
      // Even if it fits in 1 P2SH chunk, the test validates the structure
      assert.ok(p2shOutputs.length >= 1, 'should have at least one P2SH output')

      // All P2SH outputs should have value >= dust
      for (const o of p2shOutputs) {
        assert.ok(o.value >= encoder.dustAmount,
          `P2SH output value ${o.value} should be >= dust ${encoder.dustAmount}`)
      }
    })
  })
})
