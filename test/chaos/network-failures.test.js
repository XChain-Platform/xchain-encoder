/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Chaos Engineering — Category A: Network & Dependency Failures
 *
 * Tests encoder resilience when BlockchainConnector and UtxoTracker
 * experience connection failures, invalid responses, intermittent
 * errors, and high latency.
 */

const assert = require('assert')
const {
  TXID_A, makeSegwitUtxo, makeLegacyUtxo, makeEncoder, getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'
const ADDRESS = getTestAddress(NETWORK)

describe('Chaos Category A: Network & Dependency Failures', () => {

  // ── A-1: Coin daemon completely unreachable ───────────────────

  describe('A-1: Coin daemon unreachable (ECONNREFUSED)', () => {
    it('getFeePerKilobyte failure propagates when feePerKb not provided', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      encoder.connector.getFeePerKilobyte = async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:8332')
        err.code = 'ECONNREFUSED'
        throw err
      }

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], ADDRESS, null,
          actions.makeSend().data, null, null, false, null, ADDRESS,
          null, null, null, true, null
        ),
        /ECONNREFUSED/
      )
    })

    it('getTransactionHex failure propagates for legacy UTXO', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeLegacyUtxo(TXID_A, 0, 100000000)

      encoder.connector.getTransactionHex = async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:8332')
        err.code = 'ECONNREFUSED'
        throw err
      }

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        /ECONNREFUSED/
      )
    })

    it('feePerKb parameter bypasses broken getFeePerKilobyte', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('ECONNREFUSED')
      }

      const result = await encoder.createTransaction(
        [utxo], ADDRESS, null,
        actions.makeSend().data, null, null, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt)
    })
  })

  // ── A-2: Coin daemon returns invalid JSON ─────────────────────

  describe('A-2: Coin daemon returns invalid JSON (502 HTML)', () => {
    it('SyntaxError from JSON parse propagates', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      encoder.connector.getFeePerKilobyte = async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      }

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], ADDRESS, null,
          actions.makeSend().data, null, null, false, null, ADDRESS,
          null, null, null, true, null
        ),
        /Unexpected token/
      )
    })
  })

  // ── A-3: Coin daemon returns RPC error ────────────────────────

  describe('A-3: Coin daemon RPC error (node still loading)', () => {
    it('RPC error from getFeePerKilobyte propagates', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('RPC error -28: Verifying blocks...')
      }

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], ADDRESS, null,
          actions.makeSend().data, null, null, false, null, ADDRESS,
          null, null, null, true, null
        ),
        /RPC error -28/
      )
    })

    it('RPC error from getTransactionHex propagates for legacy UTXO', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeLegacyUtxo(TXID_A, 0, 100000000)

      encoder.connector.getTransactionHex = async () => {
        throw new Error('RPC error -5: No such mempool or blockchain transaction')
      }

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        /RPC error -5/
      )
    })
  })

  // ── A-4: UTXO tracker unreachable ─────────────────────────────

  describe('A-4: UTXO tracker unreachable', () => {
    it('propagates ECONNREFUSED when utxos=null', async () => {
      const encoder = makeEncoder(NETWORK)

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3001')
      }

      await assert.rejects(
        () => encoder.createTransaction(
          null, ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        /ECONNREFUSED/
      )
    })

    it('propagates ECONNREFUSED when utxos=[]', async () => {
      const encoder = makeEncoder(NETWORK)

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3001')
      }

      await assert.rejects(
        () => encoder.createTransaction(
          [], ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        /ECONNREFUSED/
      )
    })
  })

  // ── A-5: UTXO tracker malformed responses ─────────────────────

  describe('A-5: UTXO tracker malformed responses', () => {
    it('A-5a: tracker returns null → throws about no utxos', async () => {
      const encoder = makeEncoder(NETWORK)
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => null

      await assert.rejects(
        () => encoder.createTransaction(
          null, ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        /no utxos|Cannot read/i
      )
    })

    it('A-5b: tracker returns {} (no utxos key) → throws', async () => {
      const encoder = makeEncoder(NETWORK)
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({})

      await assert.rejects(
        () => encoder.createTransaction(
          null, ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        /no utxos/i
      )
    })

    it('A-5c: tracker returns { utxos: null } → throws', async () => {
      const encoder = makeEncoder(NETWORK)
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: null })

      await assert.rejects(
        () => encoder.createTransaction(
          null, ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        /no utxos/i
      )
    })

    it('A-5d: tracker returns { utxos: "not-an-array" } → throws', async () => {
      const encoder = makeEncoder(NETWORK)
      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: 'bad' })

      await assert.rejects(
        () => encoder.createTransaction(
          null, ADDRESS, null,
          actions.makeSend().data, null, 10000, false, null, ADDRESS,
          null, null, null, true, 0.00001
        ),
        /no utxos|splice is not a function|not a function/i
      )
    })
  })

  // ── A-6: Intermittent RPC failures ────────────────────────────

  describe('A-6: Intermittent RPC failures', () => {
    it('first call succeeds, second call fails (alternating pattern)', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      let callCount = 0

      encoder.connector.getFeePerKilobyte = async () => {
        callCount++
        if (callCount % 2 === 0) throw new Error('intermittent RPC failure')
        return 0.00001
      }

      // Call 1 (odd) → success
      const result1 = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], ADDRESS, null,
        actions.makeSend().data, null, null, false, null, ADDRESS,
        null, null, null, true, null
      )
      assert.ok(result1.psbt)

      // Call 2 (even) → failure
      await assert.rejects(
        () => encoder.createTransaction(
          [makeSegwitUtxo(TXID_A, 0, 100000000)], ADDRESS, null,
          actions.makeSend().data, null, null, false, null, ADDRESS,
          null, null, null, true, null
        ),
        /intermittent RPC failure/
      )

      // Call 3 (odd) → success again
      const result3 = await encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], ADDRESS, null,
        actions.makeSend().data, null, null, false, null, ADDRESS,
        null, null, null, true, null
      )
      assert.ok(result3.psbt)
    })
  })

  // ── A-7: Slow RPC responses ───────────────────────────────────

  describe('A-7: Slow RPC responses', () => {
    it('150ms delay on getFeePerKilobyte still completes', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      encoder.connector.getFeePerKilobyte = async () => {
        await new Promise(r => setTimeout(r, 150))
        return 0.00001
      }

      const start = Date.now()
      const result = await encoder.createTransaction(
        [utxo], ADDRESS, null,
        actions.makeSend().data, null, null, false, null, ADDRESS,
        null, null, null, true, null
      )
      const elapsed = Date.now() - start
      assert.ok(result.psbt)
      assert.ok(elapsed >= 100, `expected >=100ms, got ${elapsed}ms`)
      assert.ok(elapsed < 5000, `should complete in <5s, took ${elapsed}ms`)
    })

    it('150ms delay on getTransactionHex (legacy UTXO) still completes', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeLegacyUtxo(TXID_A, 0, 100000000)
      const { buildRawTxHex } = require('../integration/helpers/utxoFactory')

      encoder.connector.getTransactionHex = async () => {
        await new Promise(r => setTimeout(r, 150))
        return buildRawTxHex(100000000, NETWORK)
      }

      const start = Date.now()
      const result = await encoder.createTransaction(
        [utxo], ADDRESS, null,
        actions.makeSend().data, null, 10000, false, null, ADDRESS,
        null, null, null, true, 0.00001
      )
      const elapsed = Date.now() - start
      assert.ok(result.psbt)
      assert.ok(elapsed >= 100, `expected >=100ms, got ${elapsed}ms`)
    })
  })
})
