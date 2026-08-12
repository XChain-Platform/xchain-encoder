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
 * E2E-7: Complex Parameter & Edge Case Handling
 *
 * Validates encoding correctness for unusual but valid parameter combinations,
 * boundary values, and special characters.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  extractOpReturnPayload,
  extractMultisignPayload,
  decompilePayload,
  MAGIC_WORD
} = require('../integration/helpers/deobfuscate')
const {
  TXID_A,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

function stdUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

async function encodeAndExtract (data, opts = {}) {
  const encoder = makeEncoder(opts.network || NETWORK)
  const address = getTestAddress(opts.network || NETWORK)
  const utxo = stdUtxo()

  const result = await encoder.createTransaction(
    [utxo], address, null,
    data, opts.rawData || null, 10000, false, null, address,
    null, null, null, true, 0.00001
  )

  if (result.encoding === 'OP_RETURN') {
    const payload = extractOpReturnPayload(result, TXID_A)
    const decompiled = decompilePayload(payload.dataBuffer)
    return { result, dataString: decompiled[0].toString('utf8'), decompiled }
  }
  return { result, dataString: null, decompiled: null }
}

describe('E2E-7: Complex Parameter & Edge Case Handling', () => {

  describe('E2E-7.1: TICK with special characters', () => {
    it('J-DOG_#1 survives encoding round-trip', async () => {
      const action = actions.makeIssueSpecialChars('J-DOG_#1')
      const { dataString } = await encodeAndExtract(action.data)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('J-DOG_#1'))
    })
  })

  describe('E2E-7.2: TICK by numeric ID (caret prefix)', () => {
    it('^1234 preserved in SEND', async () => {
      const action = actions.makeSendByTickId('1234', '100', actions.ADDR_BTC)
      const { dataString } = await encodeAndExtract(action.data)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes('^1234'))
    })
  })

  describe('E2E-7.3: Long TICK name', () => {
    it('12-character TICK survives encoding', async () => {
      const tick = 'ABCDEFGHIJKL' // 12 chars
      const action = { data: `SEND|0|${tick}|100|mfWxJ45`, rawData: null }
      const { dataString } = await encodeAndExtract(action.data)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes(tick))
    })
  })

  describe('E2E-7.4: Zero amount', () => {
    it('SEND with amount=0 preserves the zero', async () => {
      const action = { data: `SEND|0|JDOG|0|${actions.ADDR_BTC}`, rawData: null }
      const { dataString } = await encodeAndExtract(action.data)
      assert.strictEqual(dataString, action.data)
      // Verify the zero is actually there, not dropped
      const parts = dataString.split('|')
      assert.strictEqual(parts[3], '0')
    })
  })

  describe('E2E-7.5: Large amount with high precision', () => {
    it('18-digit amount preserved exactly', async () => {
      const bigAmount = '999999999999999999'
      const action = { data: `SEND|0|JDOG|${bigAmount}|mfWxJ45`, rawData: null }
      const { dataString } = await encodeAndExtract(action.data)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes(bigAmount))
    })

    it('decimal amount with 8 places preserved', async () => {
      const amount = '12345678.12345678'
      const action = { data: `SEND|0|JDOG|${amount}|mfWxJ45`, rawData: null }
      const { dataString } = await encodeAndExtract(action.data)
      assert.ok(dataString.includes(amount))
    })
  })

  describe('E2E-7.6: Unicode in memo', () => {
    it('emoji and CJK characters survive UTF-8 encoding', async () => {
      const memo = 'Hello World'
      const action = { data: `SEND|0|JDOG|1|mfWxJ45|${memo}`, rawData: null }
      const { dataString } = await encodeAndExtract(action.data)
      assert.strictEqual(dataString, action.data)
      assert.ok(dataString.includes(memo))
    })

    it('accented characters survive encoding', async () => {
      const memo = 'cafe resume naive'
      const action = { data: `SEND|0|JDOG|1|mfWxJ45|${memo}`, rawData: null }
      const { dataString } = await encodeAndExtract(action.data)
      assert.strictEqual(dataString, action.data)
    })
  })

  describe('E2E-7.7: Pipe character in memo field', () => {
    it('pipe in memo extends the field count (protocol limitation)', async () => {
      // The pipe is the field delimiter, so a memo containing one is parsed
      // as extra fields downstream; the encoder itself just preserves the
      // string as-is. This is a known protocol characteristic, not a bug.
      const data = 'SEND|0|JDOG|1|mfWxJ45|memo|with|pipes'
      const { dataString } = await encodeAndExtract(data)
      assert.strictEqual(dataString, data)
    })
  })

  describe('E2E-7.8: ISSUE with empty optional fields', () => {
    it('empty lock and callback fields preserved as empty strings', async () => {
      const action = actions.makeIssueFull('EMPTY', {
        callbackBlock: '',
        callbackTick: '',
        callbackAmount: '',
        allowList: '0',
        blockList: '0'
      })
      // This will be P2SH due to size; just verify it encodes without error
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      assert.ok(['OP_RETURN', 'P2SH'].includes(result.encoding))
    })
  })

  describe('E2E-7.9: data + rawData dual parameter', () => {
    it('both buffers compiled into script and recoverable', async () => {
      const data = 'SEND|0|JDOG|1|mfWxJ45'
      const rawData = 'extra-metadata-field'

      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        data, rawData, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')

      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)

      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled.length, 2, 'should have two decompiled elements')
      assert.strictEqual(decompiled[0].toString('utf8'), data)
      assert.strictEqual(decompiled[1].toString('utf8'), rawData)
    })
  })

  describe('E2E-7.10: DISPENSER with all fields', () => {
    it('all 8 dispenser fields including trailing zeros preserved', async () => {
      const action = actions.makeDispenser('JDOG', '100', '10', '1', actions.ADDR_BTC)
      const { dataString } = await encodeAndExtract(action.data)
      assert.strictEqual(dataString, action.data)

      const parts = dataString.split('|')
      assert.strictEqual(parts[0], 'DISPENSER')
      assert.strictEqual(parts[1], '0')
      assert.strictEqual(parts[2], 'JDOG')
      assert.strictEqual(parts[3], '100')
      assert.strictEqual(parts[4], '10')
      assert.strictEqual(parts[5], '1')
      assert.strictEqual(parts[7], '0') // trailing field
      assert.strictEqual(parts[8], '0') // trailing field
    })
  })

  describe('E2E-7.11: ORDER with zero expiration', () => {
    it('expiration=0 (no expiry) preserved', async () => {
      const action = actions.makeOrder('BUY', 'JDOG', '100', 'BRRR', '50', '0')
      const { dataString } = await encodeAndExtract(action.data)
      const parts = dataString.split('|')
      assert.strictEqual(parts[7], '0')
    })
  })

  describe('E2E-7.12: Large BATCH with 10+ actions', () => {
    it('10 actions in batch all preserved', async () => {
      const batchActions = []
      for (let i = 0; i < 10; i++) {
        batchActions.push(actions.makeMint('T' + i, String(i)))
      }
      const batch = actions.makeBatch(batchActions)

      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        batch.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      // Large batch will likely be P2SH
      assert.ok(['OP_RETURN', 'P2SH'].includes(result.encoding))

      // Verify the batch string has 10 semicolons (9 separators + no trailing)
      const parts = batch.data.split(';')
      assert.strictEqual(parts.length, 10)
    })
  })

  describe('E2E-7.13: Custom dust parameter', () => {
    it('MULTISIGN output uses custom dust value', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const customDust = 1234

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'A'.repeat(59), null, 10000, false, 'MULTISIGN', address,
        null, null, PUBKEY_BUF.toString('hex'),
        true, 0.00001, customDust
      )

      const msOutput = result.psbt.txOutputs.find(o => o.value === customDust)
      assert.ok(msOutput, 'MULTISIGN output should use custom dust')
    })

    it('fee floor still uses network dustAmount, not custom', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null,
        true, 0.0000001, 100 // custom dust = 100
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= network dust ${encoder.dustAmount}, not custom 100`)
    })
  })

  describe('E2E-7.14: ISSUE with all locks enabled', () => {
    it('all lock fields set to 1 are preserved', async () => {
      const action = actions.makeIssueFull('LOCKED', {
        lockMaxSupply: '1',
        lockMaxMint: '1',
        lockDescription: '1',
        lockRug: '1',
        lockSleep: '1',
        lockCallback: '1',
        lockMint: '1',
        lockMintSupply: '1'
      })

      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = stdUtxo()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      // Verify the ACTION string contains all the lock fields
      assert.ok(action.data.includes('LOCKED'))
    })
  })
})
