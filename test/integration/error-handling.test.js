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
 * Category H: Error Handling at Integration Boundaries
 *
 * Verifies that errors from dependencies (BlockchainConnector, UtxoTracker,
 * bitcoinjs-lib) are properly propagated and that invalid inputs produce
 * meaningful error messages.
 */

const assert = require('assert')
const XChainEncoder = require('../../src/XChainEncoder')
const {
  TXID_A,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress,
  buildRawTxHex
} = require('./helpers/utxoFactory')
const actions = require('./helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

describe('Category H: Error Handling at Integration Boundaries', () => {

  describe('H-1: BlockchainConnector.getFeePerKilobyte() failure', () => {
    it('propagates error when fee estimation RPC fails', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('RPC connection refused')
      }

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          action.data, null, null, false, null, address,
          null, null, null, true, null // force RPC call
        ),
        /RPC connection refused/
      )
    })

    it('does NOT fail when feePerKb is provided (bypasses RPC)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('RPC connection refused')
      }

      // Should succeed because feePerKb bypasses the RPC call
      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt)
    })
  })

  describe('H-2: BlockchainConnector.getTransactionHex() failure', () => {
    it('propagates error when fetching raw tx for legacy UTXO fails', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      encoder.connector.getTransactionHex = async () => {
        throw new Error('Transaction not found')
      }

      // Use a legacy (P2PKH) UTXO that requires getTransactionHex
      const legacyUtxo = {
        txid: TXID_A,
        vout: 0,
        value: 100000000,
        confirmations: 6,
        // P2PKH scriptPubKey (non-segwit)
        scriptPubKey: '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac'
      }

      await assert.rejects(
        () => encoder.createTransaction(
          [legacyUtxo], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        /Transaction not found/
      )
    })
  })

  describe('H-3: UtxoTracker unreachable', () => {
    it('propagates error when tracker is down and utxos=null', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => {
        throw new Error('ECONNREFUSED')
      }

      await assert.rejects(
        () => encoder.createTransaction(
          null, address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        ),
        /ECONNREFUSED/
      )
    })
  })

  describe('H-4: Invalid network name', () => {
    it('throws TypeError during construction for invalid network', () => {
      assert.throws(
        () => new XChainEncoder(
          'invalid-network', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
        ),
        { name: 'TypeError' }
      )
    })
  })

  describe('H-5: MULTISIGN without compressedPubKey', () => {
    it('throws when compressedPubKey is null', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'A'.repeat(59), null, 10000, false, 'MULTISIGN', address,
          null, null, null, // compressedPubKey = null
          true, 0.00001
        )
      )
    })
  })

  describe('H-6: P2SH without valid pubkey address', () => {
    it('throws when pubkey is not a valid base58 address', async () => {
      const encoder = makeEncoder(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('BIGTOKEN')

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], 'not-a-valid-address', null,
          action.data, null, 10000, false, null, 'not-a-valid-address',
          null, null, null, true, 0.00001
        )
      )
    })
  })

  describe('Return value shape', () => {
    it('returns { psbt, encoding } where psbt is a Psbt instance', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof require('bitcoinjs-lib').Psbt)
      assert.strictEqual(typeof result.encoding, 'string')
      assert.ok(['OP_RETURN', 'P2SH', 'P2WSH', 'MULTISIGN'].includes(result.encoding))
    })
  })

  describe('Custom dust parameter', () => {
    it('overrides dust for MULTISIGN output value but not fee floor', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const compressedPubKey = PUBKEY_BUF.toString('hex')
      const customDust = 1234
      const MS_DATA = 'A'.repeat(59)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', address,
        null, null, compressedPubKey,
        true, 0.00001, customDust
      )

      const msOutput = result.psbt.txOutputs.find(o => o.value === customDust)
      assert.ok(msOutput, 'MULTISIGN output should use custom dust value')
    })

    it('fee floor still uses network dustAmount, not custom dust', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      // Custom dust = 100, much less than network dust (546)
      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null,
        true, 0.0000001, 100
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= encoder.dustAmount,
        `fee ${impliedFee} should be >= network dustAmount ${encoder.dustAmount}, not custom dust 100`)
    })
  })
})
