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
 * REG-05: Multi-Chain Network Configs
 *
 * Regression sentinel for Bitcoin, Litecoin, and Dogecoin network parameter
 * correctness. Verifies that all 9 network names resolve, chain-specific
 * dust thresholds are applied, and P2WSH is blocked on non-segwit chains.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../../src/CryptoNetworks')
const {
  extractOpReturnPayload,
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

const COMPRESSED_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const ALL_NETWORKS = [
  'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
  'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
  'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest'
]

describe('REG-05: Multi-Chain Network Configs', function () {

  // ── REG-05.1: All 9 networks resolve ──────────────────────────

  describe('REG-05.1: All 9 networks resolve', function () {
    for (const network of ALL_NETWORKS) {
      it(`${network} resolves with dustThreshold`, function () {
        const config = CryptoNetworks.getBitcoinJsNetwork(network)
        assert.ok(config, `${network} should resolve`)
        assert.ok(typeof config.dustThreshold === 'number',
          `${network} should have numeric dustThreshold`)
      })
    }

    it('unknown network throws', function () {
      assert.throws(
        () => CryptoNetworks.getBitcoinJsNetwork('ethereum-mainnet'),
        (err) => err instanceof Error
      )
    })
  })

  // ── REG-05.2: Bitcoin (regtest) OP_RETURN ─────────────────────

  describe('REG-05.2: Bitcoin (regtest) OP_RETURN', function () {
    it('produces valid PSBT with correct encoding', async function () {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
      const payload = extractOpReturnPayload(result, TXID_A)
      assert.strictEqual(payload.magic, MAGIC_WORD)
    })

    it('dustAmount is 546', function () {
      const encoder = makeEncoder('bitcoin-regtest')
      assert.strictEqual(encoder.dustAmount, 546)
    })
  })

  // ── REG-05.3: Dogecoin (regtest) OP_RETURN ────────────────────

  describe('REG-05.3: Dogecoin (regtest) OP_RETURN', function () {
    it('produces valid PSBT with correct encoding', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('dustAmount is 100000 (Dogecoin Core hard dust limit)', function () {
      const encoder = makeEncoder('dogecoin-regtest')
      assert.strictEqual(encoder.dustAmount, 100000)
    })

    it('P2WSH encoding throws TypeError', async function () {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeFileLarge()

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, 'P2WSH', address,
          null, null, null, true, 0.00001
        ),
        { name: 'TypeError' }
      )
    })
  })

  // ── REG-05.4: Litecoin (regtest) OP_RETURN ────────────────────

  describe('REG-05.4: Litecoin (regtest) OP_RETURN', function () {
    it('produces valid PSBT with correct encoding', async function () {
      const encoder = makeEncoder('litecoin-regtest')
      const address = getTestAddress('litecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('dustAmount is 5460 (10x BTC)', function () {
      const encoder = makeEncoder('litecoin-regtest')
      assert.strictEqual(encoder.dustAmount, 5460)
    })

    it('fee is floored to 5460 not 546', async function () {
      const encoder = makeEncoder('litecoin-regtest')
      const address = getTestAddress('litecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.0000001
      )

      const totalOutput = result.psbt.txOutputs.reduce((s, o) => s + o.value, 0)
      const impliedFee = 100000000 - totalOutput
      assert.ok(impliedFee >= 5460,
        `Litecoin fee ${impliedFee} should be >= 5460`)
    })
  })

  // ── REG-05.5: P2SH dust per chain ────────────────────────────

  describe('REG-05.5: P2SH dust per chain', function () {
    for (const [network, expectedDust] of [
      ['bitcoin-regtest', 546],
      ['litecoin-regtest', 5460],
      ['dogecoin-regtest', 100000]
    ]) {
      it(`${network} P2SH output value >= ${expectedDust}`, async function () {
        const encoder = makeEncoder(network)
        const address = getTestAddress(network)
        const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
        const action = actions.makeIssueFull('TOKEN')

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.strictEqual(result.encoding, 'P2SH')

        const p2shOutputs = result.psbt.txOutputs.filter(o => {
          if (o.value <= 0) return false
          const d = bitcoin.script.decompile(o.script)
          return d && d[0] === bitcoin.opcodes.OP_HASH160
        })

        for (const o of p2shOutputs) {
          assert.ok(o.value >= expectedDust,
            `${network} P2SH output ${o.value} should be >= ${expectedDust}`)
        }
      })
    }
  })

  // ── REG-05.6: MULTISIGN dust per chain ────────────────────────

  describe('REG-05.6: MULTISIGN dust per chain', function () {
    for (const [network, expectedDust] of [
      ['bitcoin-regtest', 546],
      ['litecoin-regtest', 5460]
    ]) {
      it(`${network} MULTISIGN output value = ${expectedDust}`, async function () {
        const encoder = makeEncoder(network)
        const address = getTestAddress(network)
        const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
        const action = actions.makeSend()

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, 'MULTISIGN', address,
          null, null, COMPRESSED_PUBKEY, true, 0.00001
        )

        // MULTISIGN data outputs are funded at max(chain dust floor, bare-
        // multisig dust). A 1-of-3 bare multisig output is larger than a P2PKH,
        // so its real dust floor can exceed the flat value (e.g. ~786 > 546 on
        // BTC; see XChainEncoder bareMultisigDust). Assert each data output
        // clears the chain dust floor, mirroring the P2SH sibling above.
        const msOutputs = result.psbt.txOutputs.filter(o => {
          if (o.value <= 0) return false
          const d = bitcoin.script.decompile(o.script)
          return d && d[d.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG
        })
        assert.ok(msOutputs.length >= 1,
          `${network} should have at least one MULTISIGN data output`)
        for (const o of msOutputs) {
          assert.ok(o.value >= expectedDust,
            `${network} MULTISIGN output ${o.value} should be >= ${expectedDust}`)
        }
      })
    }
  })
})
