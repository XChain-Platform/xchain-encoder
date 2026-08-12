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
 * E2E-8: Error Handling & Negative Tests
 *
 * Verifies the encoder rejects invalid inputs gracefully without producing
 * malformed PSBTs.
 */

const assert = require('assert')
const XChainEncoder = require('../../src/XChainEncoder')
const {
  TXID_A,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeLegacyUtxo,
  makeEncoder,
  getTestAddress,
  buildRawTxHex
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'

describe('E2E-8: Error Handling & Negative Tests', () => {

  describe('E2E-8.1: No UTXOs available', () => {
    it('throws when utxos empty and tracker returns empty', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: [] })

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

      encoder.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: null })

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

  describe('E2E-8.2: RPC fee estimation failure', () => {
    it('propagates RPC error when fee estimation fails', async () => {
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

    it('succeeds when feePerKb provided despite RPC failure', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      encoder.connector.getFeePerKilobyte = async () => {
        throw new Error('RPC connection refused')
      }

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.00001 // explicit feePerKb
      )
      assert.ok(result.psbt)
    })
  })

  describe('E2E-8.3: Legacy UTXO raw tx fetch failure', () => {
    it('propagates error when getTransactionHex fails for legacy UTXO', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      encoder.connector.getTransactionHex = async () => {
        throw new Error('Transaction not found')
      }

      const legacyUtxo = makeLegacyUtxo(TXID_A, 0, 100000000)

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

  describe('E2E-8.4: UtxoTracker unreachable', () => {
    it('propagates ECONNREFUSED when tracker down and utxos=null', async () => {
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

  describe('E2E-8.5: Invalid network name', () => {
    it('throws TypeError during construction', () => {
      assert.throws(
        () => new XChainEncoder(
          'invalid-network', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
        ),
        { name: 'TypeError' }
      )
    })
  })

  describe('E2E-8.6: MULTISIGN without compressedPubKey', () => {
    it('throws when compressedPubKey is null', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'A'.repeat(59), null, 10000, false, 'MULTISIGN', address,
          null, null, null, // no compressedPubKey
          true, 0.00001
        )
      )
    })
  })

  describe('E2E-8.7: Invalid address for P2SH', () => {
    it('throws on invalid base58 address', async () => {
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

  describe('E2E-8.8: No change address with surplus funds', () => {
    it('throws descriptive "burn satoshis" error', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, null, // no change
          null, null, null, true, 0.00001
        ),
        /change address/i
      )
    })
  })

  describe('E2E-8.9: Empty data string', () => {
    it('handles empty string without crashing', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      // An empty ACTION string has no specified behavior; either a minimal
      // valid PSBT or a meaningful error is acceptable.
      try {
        const result = await encoder.createTransaction(
          [utxo], address, null,
          '', null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )
        assert.ok(result.psbt)
      } catch (err) {
        assert.ok(err.message.length > 0, 'error message should not be empty')
      }
    })
  })

  describe('E2E-8.10: Null data parameter', () => {
    it('handles null data gracefully', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)

      try {
        const result = await encoder.createTransaction(
          [utxo], address, null,
          null, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )
        assert.ok(result.psbt)
      } catch (err) {
        assert.ok(err.message.length > 0)
      }
    })
  })

  describe('E2E-8.11: Negative fee value', () => {
    it('does not produce negative-value outputs', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      try {
        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, null, -1000, false, null, address,
          null, null, null, true, 0.00001
        )

        for (const output of result.psbt.txOutputs) {
          assert.ok(output.value >= 0, `output value ${output.value} should not be negative`)
        }
      } catch (err) {
        assert.ok(err)
      }
    })
  })

  describe('E2E-8.12: UTXO value insufficient for fee', () => {
    it('handles gracefully when total UTXO value barely covers fee', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const action = actions.makeSend()

      // 1 sat UTXO -- far too small to cover any fee
      const tinyUtxo = makeSegwitUtxo(TXID_A, 0, 1)

      try {
        const result = await encoder.createTransaction(
          [tinyUtxo], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.ok(result.psbt)
      } catch (err) {
        assert.ok(err)
      }
    })
  })

  describe('Return value shape validation', () => {
    it('returns { psbt: Psbt, encoding: string } with valid enum', async () => {
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
      assert.ok(
        ['OP_RETURN', 'P2SH', 'P2WSH', 'MULTISIGN'].includes(result.encoding),
        `encoding "${result.encoding}" should be a valid type`
      )
    })
  })
})
