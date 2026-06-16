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
 * E2E-6: Multi-Chain Validation
 *
 * Verifies encoding produces correct PSBTs for Bitcoin, Dogecoin, and Litecoin
 * with chain-specific dust thresholds and address formats.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../../src/CryptoNetworks')
const {
  TXID_A,
  TXID_MULTISIGN,
  PUBKEY_BUF,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')
const actions = require('../integration/helpers/actionFactory')
const {
  extractOpReturnPayload,
  decompilePayload,
  MAGIC_WORD
} = require('../integration/helpers/deobfuscate')

function stdUtxo () {
  return makeSegwitUtxo(TXID_A, 0, 100000000)
}

const CHAINS = [
  { name: 'bitcoin-regtest', dust: 546 },
  { name: 'dogecoin-regtest', dust: 100000 },
  { name: 'litecoin-regtest', dust: 5460 }
]

describe('E2E-6: Multi-Chain Validation', () => {

  // ── E2E-6.1/6.2/6.3: OP_RETURN per chain ─────────────────────

  for (const chain of CHAINS) {
    describe(`E2E-6.${CHAINS.indexOf(chain) + 1}: ${chain.name} OP_RETURN`, () => {
      it('creates valid OP_RETURN PSBT with correct dust threshold', async () => {
        const encoder = makeEncoder(chain.name)
        const address = getTestAddress(chain.name)
        const utxo = stdUtxo()
        const action = actions.makeSend()

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.ok(result.psbt instanceof bitcoin.Psbt)
        assert.strictEqual(result.encoding, 'OP_RETURN')
        assert.strictEqual(encoder.dustAmount, chain.dust)

        // Verify payload fidelity
        const payload = extractOpReturnPayload(result, TXID_A)
        assert.strictEqual(payload.magic, MAGIC_WORD)
        const decompiled = decompilePayload(payload.dataBuffer)
        assert.strictEqual(decompiled[0].toString('utf8'), action.data)
      })
    })
  }

  // ── E2E-6.4/6.5/6.6: P2SH per chain ─────────────────────────

  for (const chain of CHAINS) {
    describe(`${chain.name} P2SH`, () => {
      it('creates P2SH with output value >= chain dust threshold', async () => {
        const encoder = makeEncoder(chain.name)
        const address = getTestAddress(chain.name)
        const utxo = stdUtxo()
        const action = actions.makeIssueFull('CHAIN')

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.strictEqual(result.encoding, 'P2SH')

        const p2shOutput = result.psbt.txOutputs.find(o => {
          if (o.value <= 0 || o.value >= 100000000) return false
          const d = bitcoin.script.decompile(o.script)
          return d && d[0] === bitcoin.opcodes.OP_HASH160
        })
        assert.ok(p2shOutput, 'should have P2SH output')
        assert.ok(p2shOutput.value >= chain.dust,
          `P2SH output ${p2shOutput.value} should be >= ${chain.name} dust ${chain.dust}`)
      })
    })
  }

  // ── E2E-6.7: Bitcoin P2WSH ────────────────────────────────────

  describe('E2E-6.7: Bitcoin P2WSH', () => {
    it('creates P2WSH witness output on bitcoin-regtest', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = stdUtxo()
      const action = actions.makeFileLarge()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, 'P2WSH', address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2WSH')

      const p2wshOutput = result.psbt.txOutputs.find(o => {
        if (o.value <= 0) return false
        const d = bitcoin.script.decompile(o.script)
        return d && d[0] === bitcoin.opcodes.OP_0 &&
               Buffer.isBuffer(d[1]) && d[1].length === 32
      })
      assert.ok(p2wshOutput, 'should have P2WSH output')
    })
  })

  // ── E2E-6.8: Bitcoin MULTISIGN ────────────────────────────────

  describe('E2E-6.8: Bitcoin MULTISIGN (dust=546)', () => {
    it('multisig output at 546 sats', async () => {
      const encoder = makeEncoder('bitcoin-regtest')
      const address = getTestAddress('bitcoin-regtest')
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'A'.repeat(59), null, 10000, false, 'MULTISIGN', address,
        null, null, PUBKEY_BUF.toString('hex'), true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')
      const msOutput = result.psbt.txOutputs.find(o => o.value === 546)
      assert.ok(msOutput, 'Bitcoin multisig output should be 546 sats')
    })
  })

  // ── E2E-6.9: Litecoin MULTISIGN ──────────────────────────────

  describe('E2E-6.9: Litecoin MULTISIGN (dust=5460)', () => {
    it('multisig output at 5460 sats', async () => {
      const encoder = makeEncoder('litecoin-regtest')
      const address = getTestAddress('litecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'A'.repeat(59), null, 10000, false, 'MULTISIGN', address,
        null, null, PUBKEY_BUF.toString('hex'), true, 0.00001
      )

      assert.strictEqual(result.encoding, 'MULTISIGN')
      const msOutput = result.psbt.txOutputs.find(o => o.value === 5460)
      assert.ok(msOutput, 'Litecoin multisig output should be 5460 sats')
    })
  })

  // ── E2E-6.10: All 9 network configs ──────────────────────────

  describe('E2E-6.10: All 9 network configs valid', () => {
    const ALL_NETWORKS = [
      'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
      'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
      'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest'
    ]

    for (const network of ALL_NETWORKS) {
      it(`${network} has valid config with positive dustThreshold`, () => {
        const config = CryptoNetworks.getBitcoinJsNetwork(network)
        assert.ok(config, `config should exist for ${network}`)
        assert.ok(typeof config.dustThreshold === 'number')
        assert.ok(config.dustThreshold > 0)
      })
    }
  })

  // ── Fee floor uses chain-specific dust ────────────────────────

  describe('Fee floor uses chain-specific dust', () => {
    it('Litecoin fee floor is 5460, not 546', async () => {
      const encoder = makeEncoder('litecoin-regtest')
      const address = getTestAddress('litecoin-regtest')
      const utxo = stdUtxo()
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.0000001 // very low
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= 5460, `Litecoin fee ${impliedFee} should be >= 5460`)
    })
  })
})
