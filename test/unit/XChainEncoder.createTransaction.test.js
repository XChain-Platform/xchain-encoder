const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const crypto = require('crypto')
const XChainEncoder = require('../../src/XChainEncoder')

// Generate a deterministic keypair for test fixtures
const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
// TEST_ADDRESS will be set after DOGE_REGTEST is available (see below)

// A valid-looking 64-char hex txid
const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)
// A TXID that produces valid EC points when used with MULTISIGN test data
// (found by brute-force: 'A'.repeat(59) compiled to 60 bytes → 64-byte chunk after magic)
const TXID_MS = '4e3472b63a459d2188711abcff6aa2548948f90c527aa60ec4a1101136879fe8'

// Build a minimal valid raw transaction hex for nonWitnessUtxo mocking
function buildRawTxHex (value) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  const p2pkhScript = bitcoin.payments.p2pkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  }).output
  tx.addOutput(p2pkhScript, value)
  return tx.toHex()
}

const RAW_TX_HEX = buildRawTxHex(100000000) // 1 BTC in sats

// Build segwit UTXO fixtures (use DOGE_REGTEST-compatible scripts won't work for
// p2wpkh since dogecoin doesn't have bech32, so we craft a raw P2WPKH scriptPubKey)
function makeSegwitUtxo (txid, vout, value) {
  // Craft a P2WPKH scriptPubKey directly: OP_0 <20-byte-hash>
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  })
  return {
    txid,
    vout,
    value,
    confirmations: 6,
    scriptPubKey: p2wpkh.output.toString('hex')
  }
}

function makeEncoder () {
  // Use dogecoin-regtest because its CryptoNetworks config includes dustThreshold.
  // bitcoin-regtest uses the built-in bitcoinjs-lib object which lacks dustThreshold,
  // making this.dustAmount undefined unless set via env/constructor.
  const encoder = new XChainEncoder(
    'dogecoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  // Mock the BlockchainConnector
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => ({ hex: RAW_TX_HEX })
  }
  // Mock the UtxoTracker
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)]
    })
  }
  return encoder
}

// Dogecoin regtest network for address generation in tests
const DOGE_REGTEST = require('../../src/CryptoNetworks').getBitcoinJsNetwork('dogecoin-regtest')
const TEST_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: pubkeyBuf,
  network: DOGE_REGTEST
}).address

describe('XChainEncoder.createTransaction()', () => {

  // ── UTXO deduplication ───────────────────────────────────────────

  describe('UTXO deduplication', () => {
    it('removes duplicate UTXOs with same txid+vout', async () => {
      const encoder = makeEncoder()
      const dup1 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const dup2 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const unique = makeSegwitUtxo(TXID_B, 1, 30000000)

      const result = await encoder.createTransaction(
        [dup1, dup2, unique], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Should have used at most 2 unique UTXOs as inputs
      assert.ok(result.psbt.data.inputs.length <= 2)
    })
  })

  // ── Unconfirmed filtering ────────────────────────────────────────

  describe('unconfirmed filtering', () => {
    it('excludes mempool UTXOs when unconfirmed=false', async () => {
      const encoder = makeEncoder()
      const confirmed = makeSegwitUtxo(TXID_A, 0, 100000000)
      confirmed.confirmations = 6
      const mempool = makeSegwitUtxo(TXID_B, 0, 50000000)
      mempool.confirmations = 0

      const result = await encoder.createTransaction(
        [mempool, confirmed], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, false, 0.00001
      )

      // Only the confirmed UTXO should be used
      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })

    it('keeps mempool UTXOs when unconfirmed=true', async () => {
      const encoder = makeEncoder()
      const mempool = makeSegwitUtxo(TXID_A, 0, 100000000)
      mempool.confirmations = 0

      const result = await encoder.createTransaction(
        [mempool], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })

  // ── UTXO sorting ─────────────────────────────────────────────────

  describe('UTXO sorting (largest first)', () => {
    it('uses the largest UTXO first', async () => {
      const encoder = makeEncoder()
      const small = makeSegwitUtxo(TXID_A, 0, 10000000)
      const large = makeSegwitUtxo(TXID_B, 0, 100000000)

      const result = await encoder.createTransaction(
        [small, large], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // The large UTXO alone covers the fee, so only 1 input needed
      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })

  // ── Replace-by-fee ───────────────────────────────────────────────

  describe('replace-by-fee sequence', () => {
    it('sets sequence to 0x00000001 when rbf=true', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, true, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const inputData = result.psbt.txInputs[0]
      assert.strictEqual(inputData.sequence, 0x00000001)
    })

    it('sets sequence to 0xffffffff when rbf=false', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const inputData = result.psbt.txInputs[0]
      assert.strictEqual(inputData.sequence, 0xffffffff)
    })
  })

  // ── Fee handling ─────────────────────────────────────────────────

  describe('fee handling', () => {
    it('uses custom fee when provided', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const customFee = 50000

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, customFee, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Change = input - fee (no other outputs besides OP_RETURN which is 0)
      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.strictEqual(changeOutput.value, 100000000 - customFee)
    })

    it('floors fee to dustAmount when computed fee is lower', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      // Very low feePerKb should produce a fee below dust
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, null, false, null, TEST_ADDRESS,
        null, null, null, true, 0.0000001 // very low fee rate
      )

      // The change should reflect dust-floored fee
      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= dustAmount ${encoder.dustAmount}`)
    })

    it('uses feePerKb parameter when provided (no RPC call)', async () => {
      const encoder = makeEncoder()
      // Make the RPC mock throw to prove it's not called
      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('should not be called')
      }
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Should not throw because feePerKb is provided
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, null, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt)
    })

    it('calls connector.getFeePerKilobyte when feePerKb is null', async () => {
      const encoder = makeEncoder()
      let called = false
      encoder.connector.getFeePerKilobyte = async () => {
        called = true
        return 0.00001
      }
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, null, false, null, TEST_ADDRESS,
        null, null, null, true, null
      )
      assert.strictEqual(called, true)
    })
  })

  // ── Custom dust ──────────────────────────────────────────────────

  describe('custom dust parameter', () => {
    it('overrides finalDust for MULTISIGN output value', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')
      const customDust = 1234

      const MS_DATA = 'A'.repeat(59)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey,
        true, 0.00001, customDust
      )

      // The MULTISIGN output should use the custom dust value
      const msOutput = result.psbt.txOutputs.find(o => o.value === customDust)
      assert.ok(msOutput, 'MULTISIGN output should use custom dust value of 1234')
    })

    it('does NOT override the fee floor (fee floor uses this.dustAmount)', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Pass custom dust smaller than network dustAmount
      // Fee floor should still use this.dustAmount (546), not the custom dust
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, null, false, null, TEST_ADDRESS,
        null, null, null,
        true, 0.0000001, 100 // custom dust = 100, but network dust = 546
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= network dustAmount ${encoder.dustAmount}`)
    })
  })

  // ── Change output ────────────────────────────────────────────────

  describe('change output', () => {
    it('adds change output when there is leftover and change address given', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      assert.ok(changeOutput, 'change output should exist')
      assert.strictEqual(changeOutput.value, 100000000 - 10000)
    })

    it('throws when change address is falsy and change would be burned', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], TEST_ADDRESS, null,
          'test', null, 10000, false, null, null, // no change address
          null, null, null, true, 0.00001
        ),
        /change address/i
      )
    })
  })

  // ── No UTXOs error ───────────────────────────────────────────────

  describe('no UTXOs available', () => {
    it('throws when utxos is empty and tracker returns nothing', async () => {
      const encoder = makeEncoder()
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: []
      })

      await assert.rejects(
        () => encoder.createTransaction(
          [], TEST_ADDRESS, null,
          'test', null, 10000, false, null, TEST_ADDRESS,
          null, null, null, true, 0.00001
        ),
        /no utxos/i
      )
    })

    it('throws when utxos is null and tracker returns null', async () => {
      const encoder = makeEncoder()
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: null
      })

      await assert.rejects(
        () => encoder.createTransaction(
          null, TEST_ADDRESS, null,
          'test', null, 10000, false, null, TEST_ADDRESS,
          null, null, null, true, 0.00001
        ),
        /no utxos/i
      )
    })

    it('falls back to utxoTracker when utxos param is null', async () => {
      const encoder = makeEncoder()
      let trackerCalled = false
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        return { utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)] }
      }

      await encoder.createTransaction(
        null, TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(trackerCalled, true)
    })
  })

  // ── Custom outputs ───────────────────────────────────────────────

  describe('custom outputs', () => {
    it('adds custom outputs with correct address and value', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const customOutputs = [
        { address: TEST_ADDRESS, value: '500000' },
        { address: TEST_ADDRESS, value: '300000' }
      ]

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, customOutputs,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Should have: OP_RETURN (0 value) + 2 custom + 1 change = 4 outputs
      const outputs = result.psbt.txOutputs
      const customValues = outputs.filter(o =>
        o.value === 500000 || o.value === 300000
      )
      assert.strictEqual(customValues.length, 2)
    })

    it('skips custom outputs when customOutputs is not an array', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // Pass an object (not array) — should be silently skipped
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, { address: TEST_ADDRESS, value: 1000 },
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Should only have OP_RETURN + change = 2 outputs
      assert.strictEqual(result.psbt.txOutputs.length, 2)
    })

    it('skips custom outputs when customOutputs is null', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txOutputs.length, 2)
    })
  })

  // ── OP_RETURN encoding path ──────────────────────────────────────

  describe('OP_RETURN encoding path', () => {
    it('auto-selects OP_RETURN for small data and returns correct encoding', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'Small', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('OP_RETURN output has value 0', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'Data', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(opReturnOutput, 'should have an OP_RETURN output with value 0')
    })

    it('OP_RETURN output script starts with OP_RETURN opcode (0x6a)', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'Data', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const opReturnOutput = result.psbt.txOutputs.find(o => o.value === 0)
      assert.strictEqual(opReturnOutput.script[0], bitcoin.opcodes.OP_RETURN)
    })
  })

  // ── P2SH encoding path (tx1 — funding) ──────────────────────────

  describe('P2SH encoding path (tx1 — funding)', () => {
    it('creates P2SH output for large data', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const bigData = 'x'.repeat(80) // exceeds OP_RETURN limit

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
      // Should have P2SH output(s) + change
      const nonZeroOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.ok(nonZeroOutputs.length >= 2, 'should have P2SH output + change')
    })

    it('P2SH output value covers the spending tx fee', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const bigData = 'x'.repeat(80)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      const p2shOutput = result.psbt.txOutputs.find(o =>
        o.value > 0 && o.value < 100000000
      )
      assert.ok(p2shOutput, 'P2SH output should exist')
      assert.ok(p2shOutput.value >= encoder.dustAmount,
        'P2SH output value should be >= dust')
    })
  })

  // ── P2SH encoding path (tx2 — spending) ─────────────────────────

  describe('P2SH encoding path (tx2 — spending)', () => {
    it('creates tx2 with P2SH input and OP_RETURN marker', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const bigData = 'x'.repeat(80)

      // First create tx1 to get the hex
      const tx1Result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      // Extract tx1 hex (unsigned, but structurally valid for our test)
      const tx1Psbt = tx1Result.psbt
      const tx1Hex = tx1Psbt.__CACHE.__TX.toHex()
      const tx1Id = tx1Psbt.__CACHE.__TX.getId()

      // Now create tx2
      const tx2Result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        bigData, null, 10000, false, null, TEST_ADDRESS,
        tx1Id, tx1Hex, null, true, 0.00001
      )

      assert.strictEqual(tx2Result.encoding, 'P2SH')
      // tx2 should have at least 1 input (the P2SH spend)
      assert.ok(tx2Result.psbt.data.inputs.length >= 1)
      // tx2 should have an OP_RETURN marker output
      const opReturnOutput = tx2Result.psbt.txOutputs.find(o => o.value === 0)
      assert.ok(opReturnOutput, 'tx2 should have OP_RETURN marker')
    })
  })

  // ── MULTISIGN encoding path ──────────────────────────────────────

  describe('MULTISIGN encoding path', () => {
    // MULTISIGN requires fake pubkeys that are valid EC points on secp256k1.
    // dataToPubkey() prepends 0x02 and zero-pads to 33 bytes, but the x-coordinate
    // must correspond to a real curve point. We use:
    //   - TXID_MS: a brute-forced txid that produces valid points
    //   - 'A'.repeat(59): data that compiles to exactly 60 bytes, producing a 64-byte
    //     chunk (4 magic + 60 data), so both 32-byte slices are fully populated

    const MS_DATA = 'A'.repeat(59) // compiles to 60 bytes → 64-byte chunk after XCHN prefix

    it('creates multisig output with correct structure', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')

      // Find the multisig output by its script shape (a bare p2ms script ends
      // in OP_CHECKMULTISIG). Its value is the relay-fee dust floor computed
      // from the actual script size, which is larger than the flat P2PKH
      // dustAmount (546) — so we must not match on dustAmount here.
      const msOutput = result.psbt.txOutputs.find(o => {
        const d = bitcoin.script.decompile(o.script)
        return d && d[d.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG
      })
      assert.ok(msOutput, 'should have a bare-multisig output')
      assert.ok(msOutput.value >= encoder.dustAmount, 'multisig output value should be at least the dust floor')

      // Decompile the script to verify 1-of-3 structure
      const decompiled = bitcoin.script.decompile(msOutput.script)
      // OP_1 <pubkey1> <pubkey2> <pubkey3> OP_3 OP_CHECKMULTISIG
      assert.strictEqual(decompiled[0], bitcoin.opcodes.OP_1) // m = 1
      assert.ok(Buffer.isBuffer(decompiled[1])) // pubkey1
      assert.ok(Buffer.isBuffer(decompiled[2])) // pubkey2
      assert.ok(Buffer.isBuffer(decompiled[3])) // pubkey3
      assert.strictEqual(decompiled[4], bitcoin.opcodes.OP_3) // n = 3
      assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_CHECKMULTISIG)
    })

    it('third pubkey is the real compressed public key', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey, true, 0.00001
      )

      const msOutput = result.psbt.txOutputs.find(o => {
        const d = bitcoin.script.decompile(o.script)
        return d && d[d.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG
      })
      assert.ok(msOutput, 'should have a bare-multisig output')
      const decompiled = bitcoin.script.decompile(msOutput.script)
      assert.deepStrictEqual(decompiled[3], pubkeyBuf)
    })

    // ── Regression: outputs must never exceed inputs ─────────────────
    // The MULTISIGN data output carries real value (a relay-fee dust floor),
    // so that value MUST be counted toward the running output total before
    // change is computed. If it isn't, change is over-credited by exactly the
    // data-output value and total outputs exceed total inputs — bitcoinjs-lib
    // rejects the tx at extractTransaction ("Outputs are spending more than
    // Inputs") and the network rejects it as invalid.
    it('builds a valid tx where total outputs do not exceed inputs', async () => {
      const encoder = makeEncoder()
      const inputValue = 100000000
      const utxo = makeSegwitUtxo(TXID_MS, 0, inputValue)
      const compressedPubKey = pubkeyBuf.toString('hex')

      // A large dust value with a tiny fee is the exact condition that exposes
      // the bug: when the data-output value exceeds the fee, omitting it from
      // the output total over-credits change past the input total. fee=100,
      // dust=50000.
      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA, null, 100, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey, true, 0.00001, 50000
      )

      const outputTotal = result.psbt.txOutputs.reduce((sum, o) => sum + o.value, 0)
      assert.ok(
        outputTotal <= inputValue,
        `total outputs (${outputTotal}) must not exceed total inputs (${inputValue})`
      )
    })

    // ── Regression: short final chunk (≤28 data bytes) ───────────────
    // A payload whose last chunk holds ≤28 data bytes produces a final
    // magic(4)+data buffer of ≤32 bytes. Before each chunk was padded to a
    // full 64-byte slot, obfuscatedData.slice(32) was empty, so dataToPubkey()
    // returned an all-zero x-coordinate (0x02 || 0x00×32) — a secp256k1 x=0
    // point that p2ms() rejects at construction time, surfacing as a 500.
    // This payload compiles to 88 bytes → chunks of 60 + 28, exercising that
    // path end-to-end. TXID_MS_SHORT is brute-forced so every obfuscated
    // pubkey half across both chunks is a valid curve point.
    const TXID_MS_SHORT = '5efa379f1f220474a1c6d3114efb4bcac3e38d54e2003db334d1cb97c2f8bfba'
    const MS_DATA_SHORT = 'Z'.repeat(86) // compiles to 88 bytes → last chunk = magic(4) + 28

    it('encodes a short final chunk without throwing (x=0 pubkey regression)', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_MS_SHORT, 0, 100000000)
      const compressedPubKey = pubkeyBuf.toString('hex')

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        MS_DATA_SHORT, null, 10000, false, 'MULTISIGN', TEST_ADDRESS,
        null, null, compressedPubKey, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')

      // Two MULTISIGN outputs (one per 64-byte chunk), each a well-formed
      // 1-of-3 p2ms script — proving both chunks' pubkey halves are valid points.
      const msOutputs = result.psbt.txOutputs.filter(o => {
        const d = bitcoin.script.decompile(o.script)
        return d && d[d.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG
      })
      assert.strictEqual(msOutputs.length, 2, 'should emit one MULTISIGN output per chunk')
      for (const out of msOutputs) {
        const decompiled = bitcoin.script.decompile(out.script)
        assert.strictEqual(decompiled[0], bitcoin.opcodes.OP_1)
        assert.strictEqual(decompiled[4], bitcoin.opcodes.OP_3)
        assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_CHECKMULTISIG)
      }
    })
  })

  // ── Return value shape ───────────────────────────────────────────

  describe('return value', () => {
    it('returns { psbt, encoding } where psbt is a Psbt instance', async () => {
      const encoder = makeEncoder()
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], TEST_ADDRESS, null,
        'test', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.strictEqual(typeof result.encoding, 'string')
    })
  })

  // ── estimateSpendingP2shTx ───────────────────────────────────────

  describe('estimateSpendingP2shTx()', () => {
    it('returns 10 + P2SH input + OP_RETURN + 8-byte safety margin', () => {
      const encoder = makeEncoder()
      const TxSizeEstimator = require('../../src/TxSizeEstimator')
      const redeemData = Buffer.alloc(200, 0xAA)

      const expected = 10
        + TxSizeEstimator.estimateP2shInputWithRedeem(redeemData)
        + TxSizeEstimator.estimateOpReturnOutput(
            Buffer.concat([Buffer.from('XCHN'), Buffer.from('p2sh')])
          )
        + 8 // safety margin for DER-sig length jitter

      assert.strictEqual(encoder.estimateSpendingP2shTx(redeemData), expected)
    })

    it('increases monotonically with redeem data size', () => {
      const encoder = makeEncoder()
      const small = encoder.estimateSpendingP2shTx(Buffer.alloc(100))
      const large = encoder.estimateSpendingP2shTx(Buffer.alloc(400))
      assert.ok(large > small)
      // Delta is at least the raw data delta (300); the larger redeem may
      // cross the OP_PUSHDATA2 (256) and scriptSig-varint (253) boundaries,
      // each adding bytes — so we assert monotonicity, not exact equality.
      assert.ok(large - small >= 300)
    })
  })
})
