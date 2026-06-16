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
 * REG-07: Action Pipeline Regression
 *
 * Regression sentinel for key ACTION types surviving the full encode→decode
 * pipeline. Tests a curated set of representative ACTIONs: small (SEND),
 * large (ISSUE), multi-recipient (MULTISEND), DEX (ORDER), multi-chunk
 * (BROADCAST), witness (FILE), batch delimiter (BATCH), dual-field
 * (data+rawData), and special characters.
 */

const assert = require('assert')
const {
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

/**
 * Encode an action and extract the decoded ACTION string via OP_RETURN.
 */
async function encodeAndExtract (actionObj, opts = {}) {
  const network = opts.network || NETWORK
  const encoder = makeEncoder(network)
  const address = getTestAddress(network)
  const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

  const result = await encoder.createTransaction(
    [utxo], address, null,
    actionObj.data, actionObj.rawData, 10000, false,
    opts.encoding || null, address,
    null, null, null, true, 0.00001
  )

  const payload = extractOpReturnPayload(result, TXID_A)
  const decompiled = decompilePayload(payload.dataBuffer)
  return { result, payload, decompiled }
}

describe('REG-07: Action Pipeline Regression', function () {

  // ── REG-07.1: SEND — baseline ─────────────────────────────────

  describe('REG-07.1: SEND — baseline round-trip', function () {
    it('SEND|0|JDOG|1|<addr> encodes and decodes exactly', async function () {
      const action = actions.makeSend('JDOG', '1')
      const { payload, decompiled } = await encodeAndExtract(action)

      assert.strictEqual(payload.magic, MAGIC_WORD)
      assert.strictEqual(decompiled[0].toString('utf8'), action.data)
    })

    it('SEND with memo field preserved', async function () {
      const action = actions.makeSend('JDOG', '100', undefined, 'test memo here')
      const { decompiled } = await encodeAndExtract(action)

      const decoded = decompiled[0].toString('utf8')
      assert.ok(decoded.includes('test memo here'), 'memo should be preserved')
      assert.strictEqual(decoded, action.data)
    })
  })

  // ── REG-07.2: ISSUE — P2SH path ──────────────────────────────

  describe('REG-07.2: ISSUE — P2SH path', function () {
    it('full ISSUE (25+ fields) auto-selects P2SH', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })

    it('minimal ISSUE fits OP_RETURN', async function () {
      const action = actions.makeIssueMinimal('X')
      const { result } = await encodeAndExtract(action)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  // ── REG-07.3: MULTISEND v2 ───────────────────────────────────

  describe('REG-07.3: MULTISEND v2 — multiple recipients', function () {
    it('two TICK|AMOUNT|DEST triplets preserved', async function () {
      // Use short addresses to keep payload within OP_RETURN limit
      const action = actions.makeMultiSendV2([
        { tick: 'A', amount: '1', dest: 'addr1' },
        { tick: 'B', amount: '2', dest: 'addr2' }
      ])

      const { decompiled } = await encodeAndExtract(action)
      const decoded = decompiled[0].toString('utf8')
      assert.strictEqual(decoded, action.data)
      assert.ok(decoded.startsWith('SEND|2|'))
    })
  })

  // ── REG-07.4: ORDER — DEX round-trip ──────────────────────────

  describe('REG-07.4: ORDER — DEX round-trip', function () {
    it('ORDER|0|BUY|JDOG|100|BRRR|50|0 survives encoding', async function () {
      const action = actions.makeOrder('BUY', 'JDOG', '100', 'BRRR', '50', '0')
      const { decompiled } = await encodeAndExtract(action)
      assert.strictEqual(decompiled[0].toString('utf8'), action.data)
    })
  })

  // ── REG-07.5: BROADCAST — oversized OP_RETURN rejected ─────────

  describe('REG-07.5: BROADCAST — oversized OP_RETURN rejected', function () {
    it('long broadcast forced to OP_RETURN is rejected', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeBroadcastLong()

      // A transaction may carry at most one OP_RETURN output; Bitcoin Core
      // rejects multi-OP_RETURN transactions as non-standard at broadcast.
      // A payload larger than one 76-byte chunk must be rejected at
      // construction rather than split into outputs that never relay.
      await assert.rejects(
        encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, 'OP_RETURN', address,
          null, null, null, true, 0.00001
        ),
        RangeError
      )
    })

    it('long broadcast auto-selects P2SH (the valid carrier for oversized data)', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeBroadcastLong()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')
    })
  })

  // ── REG-07.6: FILE — P2WSH path ──────────────────────────────

  describe('REG-07.6: FILE — P2WSH path (bitcoin-regtest)', function () {
    it('large FILE uses P2WSH on segwit-capable network', async function () {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeFileLarge()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2WSH')
    })
  })

  // ── REG-07.7: BATCH — semicolon delimiter ─────────────────────

  describe('REG-07.7: BATCH — semicolon delimiter', function () {
    it('semicolon-separated commands preserved verbatim', async function () {
      const action = actions.makeBatch([
        actions.makeSend('JDOG', '1'),
        actions.makeMint('BRRR', '50')
      ])

      const { decompiled } = await encodeAndExtract(action)
      const decoded = decompiled[0].toString('utf8')
      assert.strictEqual(decoded, action.data)
      assert.ok(decoded.includes(';'), 'should contain semicolon separator')
    })
  })

  // ── REG-07.8: data + rawData dual field ───────────────────────

  describe('REG-07.8: data + rawData dual field', function () {
    it('both data and rawData present in decompiled output', async function () {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|JDOG|1|addr', 'extra-raw-data', 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const payload = extractOpReturnPayload(result, TXID_A)
      const decompiled = decompilePayload(payload.dataBuffer)
      assert.strictEqual(decompiled.length, 2, 'should have 2 decompiled elements')
      assert.strictEqual(decompiled[0].toString('utf8'), 'SEND|0|JDOG|1|addr')
      assert.strictEqual(decompiled[1].toString('utf8'), 'extra-raw-data')
    })
  })

  // ── REG-07.9: Special characters ──────────────────────────────

  describe('REG-07.9: Special characters in payload', function () {
    it('TICK name with special chars preserved', async function () {
      const action = actions.makeIssueSpecialChars('J-DOG_#1')
      const { decompiled } = await encodeAndExtract(action)
      const decoded = decompiled[0].toString('utf8')
      assert.ok(decoded.includes('J-DOG_#1'))
    })

    it('TICK_ID caret prefix preserved', async function () {
      const action = actions.makeSendByTickId('1234', '100')
      const { decompiled } = await encodeAndExtract(action)
      const decoded = decompiled[0].toString('utf8')
      assert.ok(decoded.includes('^1234'))
    })
  })
})
