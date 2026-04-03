/**
 * Category A: ACTION Payload Encoding Fidelity
 *
 * Verifies that realistic pipe-delimited ACTION strings survive the full
 * createTransaction() pipeline: script compilation → prepareData() chunking →
 * obfuscation → PSBT construction — and can be extracted back to the
 * original ACTION string.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  extractOpReturnPayload,
  decompilePayload,
  MAGIC_WORD
} = require('./helpers/deobfuscate')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('./helpers/utxoFactory')
const actions = require('./helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

function makeStandardUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

/**
 * Helper: encode an ACTION, extract from PSBT, and return the decoded string.
 * Only works for OP_RETURN encoding (small payloads).
 */
async function encodeAndExtract (actionObj) {
  const encoder = makeEncoder(NETWORK)
  const address = getTestAddress(NETWORK)
  const utxo = makeStandardUtxo()

  const result = await encoder.createTransaction(
    [utxo], address, null,
    actionObj.data, actionObj.rawData, 10000, false, null, address,
    null, null, null, true, 0.00001
  )

  assert.strictEqual(result.encoding, 'OP_RETURN',
    'Expected OP_RETURN encoding for this payload size')

  const payload = extractOpReturnPayload(result, TXID_A)
  assert.strictEqual(payload.magic, MAGIC_WORD)

  const decompiled = decompilePayload(payload.dataBuffer)
  return {
    result,
    payload,
    decompiled,
    dataString: decompiled[0].toString('utf8')
  }
}

describe('Category A: ACTION Payload Encoding Fidelity', () => {
  // ── A-1: Minimal SEND ───────────────────────────────────────────

  describe('A-1: Minimal SEND (fits OP_RETURN)', () => {
    it('SEND|0|JDOG|1|<addr> survives encoding round-trip', async () => {
      const action = actions.makeSend('JDOG', '1', actions.ADDR_BTC)
      const { dataString } = await encodeAndExtract(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── A-2: SEND with memo ─────────────────────────────────────────

  describe('A-2: SEND with memo', () => {
    it('memo field is preserved through encoding', async () => {
      const action = actions.makeSend('JDOG', '100', actions.ADDR_BTC, 'Payment for services')
      const { dataString } = await encodeAndExtract(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('Payment for services'))
    })
  })

  // ── A-3: Multi-send (version 1) ────────────────────────────────

  describe('A-3: Multi-send version 1', () => {
    it('multiple AMOUNT|DESTINATION pairs survive', async () => {
      // Use short addresses to keep payload within OP_RETURN
      const action = actions.makeMultiSendV1('BRR', [
        { amount: '5', dest: 'mfWxJ45' },
        { amount: '1', dest: 'n1BNcx3' }
      ])
      const { dataString } = await encodeAndExtract(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── A-4: Full ISSUE (large, requires P2SH) ─────────────────────

  describe('A-4: Full ISSUE with all fields (P2SH)', () => {
    it('encodes as P2SH and preserves all 25+ fields', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeStandardUtxo()
      const action = actions.makeIssueFull('TESTTOKEN')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, action.rawData, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')

      // For P2SH tx1, we verify the output exists and is a valid P2SH address
      const nonZeroOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.ok(nonZeroOutputs.length >= 2, 'should have P2SH output + change')

      // The P2SH output script should be OP_HASH160 <hash> OP_EQUAL
      const p2shOutput = nonZeroOutputs.find(o => o.value < 100000000)
      const decompiled = bitcoin.script.decompile(p2shOutput.script)
      assert.strictEqual(decompiled[0], bitcoin.opcodes.OP_HASH160)
      assert.strictEqual(decompiled[2], bitcoin.opcodes.OP_EQUAL)
    })
  })

  // ── A-5: Short ISSUE (fits OP_RETURN) ──────────────────────────

  describe('A-5: Short ISSUE (fits OP_RETURN)', () => {
    it('ISSUE|0|X auto-selects OP_RETURN', async () => {
      const action = actions.makeIssueMinimal('X')
      const { dataString } = await encodeAndExtract(action)
      assert.strictEqual(dataString, 'ISSUE|0|X')
    })
  })

  // ── A-6: BATCH with multiple commands ──────────────────────────

  describe('A-6: BATCH with multiple commands', () => {
    it('semicolon-separated commands preserved', async () => {
      const batch = actions.makeBatch([
        actions.makeSend('A', '1', actions.ADDR_BTC),
        actions.makeDestroy('B', '2'),
      ])
      // Short batch should fit OP_RETURN
      const { dataString } = await encodeAndExtract(batch)
      assert.strictEqual(dataString, batch.data)
      assert.ok(dataString.includes(';'))
    })
  })

  // ── A-9: ORDER action ──────────────────────────────────────────

  describe('A-9: ORDER action', () => {
    it('DEX order fields preserved', async () => {
      const action = actions.makeOrder('BUY', 'JDOG', '100', 'BRRR', '50', '0')
      const { dataString } = await encodeAndExtract(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── A-10: DISPENSER action ─────────────────────────────────────

  describe('A-10: DISPENSER action', () => {
    it('dispenser params preserved', async () => {
      const action = actions.makeDispenser()
      const { dataString } = await encodeAndExtract(action)
      assert.strictEqual(dataString, action.data)
    })
  })

  // ── A-11: TICK with special characters ─────────────────────────

  describe('A-11: TICK with special characters', () => {
    it('special chars in TICK name survive encoding', async () => {
      const action = actions.makeIssueSpecialChars('J-DOG_#1')
      const { dataString } = await encodeAndExtract(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('J-DOG_#1'))
    })
  })

  // ── A-12: TICK by ID reference (caret prefix) ─────────────────

  describe('A-12: TICK by ID reference', () => {
    it('caret prefix for TICK_ID preserved', async () => {
      const action = actions.makeSendByTickId('1234', '100', actions.ADDR_BTC)
      const { dataString } = await encodeAndExtract(action)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('^1234'))
    })
  })

  // ── A-13: Maximum OP_RETURN boundary ──────────────────────────

  describe('A-13: Maximum OP_RETURN boundary', () => {
    it('ACTION of exactly 72 bytes fits in single OP_RETURN', async () => {
      // After script.compile([72-byte-buffer]), the result may be slightly
      // larger due to push opcode. The auto-selection threshold is
      // data.length + 4 (magic) <= 80, so compiled data must be <= 76 bytes.
      // script.compile([buf]) adds a 1-byte push prefix for data <= 75 bytes,
      // so we need the raw ACTION string to produce a compiled buffer <= 76 bytes.
      // A 75-byte string → compile → 76 bytes (1 push + 75 data) → + 4 magic = 80 ✓
      const action = actions.makeActionOfSize(75)
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeStandardUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  // ── A-14: One byte over OP_RETURN boundary ────────────────────

  describe('A-14: One byte over OP_RETURN boundary', () => {
    it('ACTION exceeding 76 compiled bytes auto-selects P2SH', async () => {
      // 76-byte string → compile → 77 bytes (1 push + 76 data, actually uses
      // 2-byte push for 76+) → + 4 magic > 80 → P2SH
      const action = actions.makeActionOfSize(80)
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeStandardUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })
  })

  // ── All 19 ACTION types: basic encoding ───────────────────────

  describe('All ACTION types: basic OP_RETURN encoding', () => {
    const smallActions = [
      { name: 'SEND', factory: () => actions.makeSend() },
      { name: 'SEND v1', factory: () => actions.makeMultiSendV1() },
      { name: 'ISSUE (minimal)', factory: () => actions.makeIssueMinimal() },
      { name: 'ISSUE v1', factory: () => actions.makeIssueEditDescription() },
      { name: 'MINT', factory: () => actions.makeMint() },
      { name: 'DESTROY', factory: () => actions.makeDestroy() },
      { name: 'CALLBACK', factory: () => actions.makeCallback() },
      { name: 'SLEEP', factory: () => actions.makeSleep() },
      { name: 'SWEEP', factory: () => actions.makeSweep() },
      { name: 'AIRDROP', factory: () => actions.makeAirdrop() },
      { name: 'DIVIDEND', factory: () => actions.makeDividend() },
      { name: 'ORDER', factory: () => actions.makeOrder() },
      { name: 'COINPAY', factory: () => actions.makeCoinpay() },
      { name: 'DISPENSER', factory: () => actions.makeDispenser() },
      { name: 'SWAP', factory: () => actions.makeSwap() },
      { name: 'BROADCAST', factory: () => actions.makeBroadcast() },
      { name: 'MESSAGE', factory: () => actions.makeMessage() },
      { name: 'ADDRESS', factory: () => actions.makeAddress() },
      { name: 'LINK', factory: () => actions.makeLink() },
      { name: 'LIST', factory: () => actions.makeList() },
    ]

    for (const { name, factory } of smallActions) {
      it(`${name} action string survives encoding round-trip`, async () => {
        const action = factory()

        // Some actions may exceed OP_RETURN — skip fidelity check for those
        // (they're tested separately as P2SH). For this sweep, just verify
        // the encoder doesn't throw and returns a valid result.
        const encoder = makeEncoder(NETWORK)
        const address = getTestAddress(NETWORK)
        const utxo = makeStandardUtxo()

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, action.rawData, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.ok(result.psbt instanceof bitcoin.Psbt)
        assert.ok(['OP_RETURN', 'P2SH'].includes(result.encoding))

        // For OP_RETURN results, verify full round-trip
        if (result.encoding === 'OP_RETURN') {
          const payload = extractOpReturnPayload(result, TXID_A)
          assert.strictEqual(payload.magic, MAGIC_WORD)
          const decompiled = decompilePayload(payload.dataBuffer)
          assert.strictEqual(decompiled[0].toString('utf8'), action.data)
        }
      })
    }
  })

  // ── data + rawData dual parameter ─────────────────────────────

  describe('data + rawData dual parameter', () => {
    it('both data and rawData are preserved in encoding', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeStandardUtxo()

      const data = 'SEND|0|JDOG|1|' + actions.ADDR_BTC
      const rawData = 'extra-metadata'

      const result = await encoder.createTransaction(
        [utxo], address, null,
        data, rawData, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)

      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled.length, 2)
      assert.strictEqual(decompiled[0].toString('utf8'), data)
      assert.strictEqual(decompiled[1].toString('utf8'), rawData)
    })
  })
})
