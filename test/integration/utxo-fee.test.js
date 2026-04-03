/**
 * Category D: UTXO & Fee Integration
 *
 * Verifies UTXO deduplication, sorting, filtering, fee estimation, fee caps,
 * dust floors, and change output logic with realistic ACTION payloads.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const {
  TXID_A,
  TXID_B,
  TXID_C,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeLegacyUtxo,
  makeMempoolUtxo,
  makeEncoder,
  getTestAddress,
  buildRawTxHex
} = require('./helpers/utxoFactory')
const actions = require('./helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

describe('Category D: UTXO & Fee Integration', () => {

  // ── D-1: Single large UTXO covers everything ─────────────────

  describe('D-1: Single large UTXO covers everything', () => {
    it('produces 1 input, 2 outputs (OP_RETURN + change)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
      assert.strictEqual(result.psbt.txOutputs.length, 2)

      // One OP_RETURN (value=0), one change
      const opReturn = result.psbt.txOutputs.filter(o => o.value === 0)
      const change = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(opReturn.length, 1)
      assert.strictEqual(change.length, 1)
      assert.strictEqual(change[0].value, 100000000 - 10000)
    })
  })

  // ── D-2: Multiple UTXOs needed ────────────────────────────────

  describe('D-2: Multiple UTXOs needed', () => {
    it('adds UTXOs until inputs cover outputs + fee', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      // Three small UTXOs: 1000 + 1000 + 1000 = 3000 sats
      // With fee of 2000, first UTXO (sorted largest=1000) won't cover it,
      // so encoder must add more
      const utxo1 = makeSegwitUtxo(TXID_A, 0, 1000)
      const utxo2 = makeSegwitUtxo(TXID_B, 0, 1000)
      const utxo3 = makeSegwitUtxo(TXID_C, 0, 1000)

      const result = await encoder.createTransaction(
        [utxo1, utxo2, utxo3], address, null,
        action.data, null, 2000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Should need multiple inputs to cover the fee
      assert.ok(result.psbt.data.inputs.length >= 2,
        `expected >= 2 inputs, got ${result.psbt.data.inputs.length}`)
    })
  })

  // ── D-3: Duplicate UTXO deduplication ─────────────────────────

  describe('D-3: Duplicate UTXO deduplication', () => {
    it('removes duplicate UTXOs with same txid+vout', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const dup1 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const dup2 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const dup3 = makeSegwitUtxo(TXID_A, 0, 50000000)
      const unique = makeSegwitUtxo(TXID_B, 1, 30000000)

      const result = await encoder.createTransaction(
        [dup1, dup2, dup3, unique], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // Should have at most 2 unique UTXOs as inputs
      assert.ok(result.psbt.data.inputs.length <= 2,
        `expected <= 2 inputs after dedup, got ${result.psbt.data.inputs.length}`)
    })
  })

  // ── D-4: Unconfirmed filtering ────────────────────────────────

  describe('D-4: Unconfirmed filtering with unconfirmed=false', () => {
    it('excludes mempool UTXOs when unconfirmed=false', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const confirmed = makeSegwitUtxo(TXID_A, 0, 100000000)
      confirmed.confirmations = 6
      const mempool = makeMempoolUtxo(TXID_B, 0, 50000000)

      const result = await encoder.createTransaction(
        [mempool, confirmed], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, false, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })

    it('includes mempool UTXOs when unconfirmed=true', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const mempool = makeMempoolUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [mempool], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })

  // ── D-5: UtxoTracker fallback ─────────────────────────────────

  describe('D-5: UtxoTracker fallback', () => {
    it('calls UtxoTracker when utxos param is null', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      let trackerCalled = false
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        return { utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)] }
      }

      await encoder.createTransaction(
        null, address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(trackerCalled, true)
    })

    it('calls UtxoTracker when utxos param is empty array', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      let trackerCalled = false
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        trackerCalled = true
        return { utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)] }
      }

      await encoder.createTransaction(
        [], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(trackerCalled, true)
    })
  })

  // ── D-6: No UTXOs available ───────────────────────────────────

  describe('D-6: No UTXOs available', () => {
    it('throws when utxos empty and tracker returns empty', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: []
      })

      await assert.rejects(
        () => encoder.createTransaction(
          [], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        /no utxos/i
      )
    })

    it('throws when utxos null and tracker returns null', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({
        utxos: null
      })

      await assert.rejects(
        () => encoder.createTransaction(
          null, address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        /no utxos/i
      )
    })
  })

  // ── D-7: Fee capped by maxFeePerBytes ─────────────────────────

  describe('D-7: Fee capped by maxFeePerBytes', () => {
    it('limits fee when maxFeeRateKb is set', async () => {
      // Create encoder WITH fee cap
      const capped = new XChainEncoder(
        NETWORK, '127.0.0.1', '8333', 'rpc', 'rpc', '', '', 1000 // 1000 sat/kB cap
      )
      capped.connector = {
        getFeePerKilobyte: async () => 0.00001,
        getTransactionHex: async () => ({ hex: buildRawTxHex(100000000, NETWORK) }),
        isRegtest: async () => true
      }
      capped.utxoTrackerConnector = {
        getUtxosFromAddress: async () => ({
          utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)]
        })
      }

      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      // Use a very high feePerKb that exceeds the cap
      const result = await capped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 1.0 // very high: 1 BTC/kB
      )

      // Create uncapped encoder for comparison
      const uncapped = makeEncoder(NETWORK)
      const resultUncapped = await uncapped.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 1.0 // same high fee
      )

      // Capped encoder should produce lower fee (more change)
      const cappedChange = result.psbt.txOutputs.find(o => o.value > 0)
      const uncappedChange = resultUncapped.psbt.txOutputs.find(o => o.value > 0)
      assert.ok(cappedChange.value > uncappedChange.value,
        'capped fee should leave more change than uncapped')
    })
  })

  // ── D-8: Dust floor on fee ────────────────────────────────────

  describe('D-8: Dust floor on fee', () => {
    it('floors fee to dustAmount when computed fee is lower', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.0000001 // very low fee rate
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= dustAmount ${encoder.dustAmount}`)
    })
  })

  // ── D-9: No change address throws ─────────────────────────────

  describe('D-9: No change address throws when change > dust', () => {
    it('throws error about burning satoshis', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, null, // no change address
          null, null, null, true, 0.00001
        ),
        /change address/i
      )
    })
  })

  // ── D-10: Legacy UTXO handling ────────────────────────────────

  describe('D-10: Legacy (non-segwit) UTXO handling', () => {
    it('fetches raw tx hex for nonWitnessUtxo via connector', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      let getHexCalled = false
      const rawHex = buildRawTxHex(100000000, NETWORK)
      encoder.connector.getTransactionHex = async () => {
        getHexCalled = true
        return rawHex
      }

      const utxo = makeLegacyUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(getHexCalled, true,
        'should call getTransactionHex for legacy UTXOs')
      assert.ok(result.psbt.data.inputs[0].nonWitnessUtxo,
        'input should have nonWitnessUtxo')
    })

    it('segwit UTXOs do NOT call getTransactionHex', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      let getHexCalled = false
      encoder.connector.getTransactionHex = async () => {
        getHexCalled = true
        return { hex: buildRawTxHex(100000000, NETWORK) }
      }

      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(getHexCalled, false,
        'should NOT call getTransactionHex for segwit UTXOs')
    })
  })

  // ── UTXO sorting (largest first) ──────────────────────────────

  describe('UTXO sorting (largest first)', () => {
    it('uses largest UTXO first, needing fewer inputs', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      const small = makeSegwitUtxo(TXID_A, 0, 10000000)   // 0.1 BTC
      const large = makeSegwitUtxo(TXID_B, 0, 100000000)  // 1 BTC

      const result = await encoder.createTransaction(
        [small, large], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      // The large UTXO alone covers everything, so only 1 input needed
      assert.strictEqual(result.psbt.data.inputs.length, 1)
    })
  })

  // ── Replace-by-fee sequence ───────────────────────────────────

  describe('Replace-by-fee sequence', () => {
    it('sets sequence to 0x00000001 when rbf=true', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, true, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txInputs[0].sequence, 0x00000001)
    })

    it('sets sequence to 0xffffffff when rbf=false', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.psbt.txInputs[0].sequence, 0xffffffff)
    })
  })

  // ── Fee source selection ──────────────────────────────────────

  describe('Fee source selection', () => {
    it('uses feePerKb parameter without RPC call', async () => {
      const encoder = makeEncoder(NETWORK)
      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('should not be called')
      }

      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      // Should not throw because feePerKb is provided
      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt)
    })

    it('calls connector.getFeePerKilobyte when feePerKb is null', async () => {
      const encoder = makeEncoder(NETWORK)
      let called = false
      encoder.connector.getFeePerKilobyte = async () => {
        called = true
        return 0.00001
      }

      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, null
      )
      assert.strictEqual(called, true)
    })
  })
})
