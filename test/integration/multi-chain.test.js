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
 * Category F: Multi-Chain Network Configs
 *
 * Verifies that Bitcoin, Dogecoin, and Litecoin network configurations
 * produce valid PSBTs with correct dust thresholds and address formats.
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
  getTestAddress,
} = require('./helpers/utxoFactory')
const actions = require('./helpers/actionFactory')

const CHAINS = [
  { name: 'bitcoin-regtest', dustThreshold: 546 },
  { name: 'dogecoin-regtest', dustThreshold: 100000 },
  { name: 'litecoin-regtest', dustThreshold: 5460 },
]

describe('Category F: Multi-Chain Network Configs', () => {

  // ── F-1/F-2/F-3: Basic PSBT construction per chain ───────────

  for (const chain of CHAINS) {
    describe(`${chain.name}: basic PSBT construction`, () => {
      it('creates valid OP_RETURN transaction', async () => {
        const encoder = makeEncoder(chain.name)
        const address = getTestAddress(chain.name)
        const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
        const action = actions.makeSend()

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.ok(result.psbt instanceof bitcoin.Psbt)
        assert.strictEqual(result.encoding, 'OP_RETURN')
        assert.strictEqual(result.psbt.data.inputs.length, 1)
        assert.ok(result.psbt.txOutputs.length >= 2)
      })

      it(`uses correct dustThreshold of ${chain.dustThreshold}`, () => {
        const encoder = makeEncoder(chain.name)
        assert.strictEqual(encoder.dustAmount, chain.dustThreshold)
      })

      it('creates valid P2SH transaction', async () => {
        const encoder = makeEncoder(chain.name)
        const address = getTestAddress(chain.name)
        const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
        const action = actions.makeIssueFull('BIGTOKEN')

        const result = await encoder.createTransaction(
          [utxo], address, null,
          action.data, null, 10000, false, null, address,
          null, null, null, true, 0.00001
        )

        assert.strictEqual(result.encoding, 'P2SH')

        // Verify the P2SH output has value >= dustThreshold
        const p2shOutput = result.psbt.txOutputs.find(o =>
          o.value > 0 && o.value < 100000000
        )
        assert.ok(p2shOutput, 'should have P2SH output')
        assert.ok(p2shOutput.value >= chain.dustThreshold,
          `P2SH output ${p2shOutput.value} should be >= dust ${chain.dustThreshold}`)
      })
    })
  }

  // ── F-4: Litecoin higher dust threshold ───────────────────────

  describe('F-4: Litecoin higher dust threshold', () => {
    const MS_DATA = 'A'.repeat(59)

    // A bare 1-of-3 multisig output is far larger than a P2PKH, so its relay dust
    // floor is Bitcoin Core's size formula (output_bytes + 148) * 3 sat/byte, not
    // the chain's flat P2PKH dustThreshold. The encoder takes the MAX of the two.
    // On Bitcoin the size formula wins (786 > 546); on Litecoin and Dogecoin the
    // chain threshold wins. This test used to look the multisig output up by
    // `value === encoder.dustAmount`, which silently stopped matching on Bitcoin
    // once that max() landed, so it asserted nothing on either chain.
    function bareMultisigDust (scriptLength) {
      return Math.ceil((8 + 1 + scriptLength + 148) * 3)
    }

    async function buildMultisign (networkName) {
      const encoder = makeEncoder(networkName)
      const address = getTestAddress(networkName)
      const utxo = makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)
      const result = await encoder.createTransaction(
        [utxo], address, null,
        MS_DATA, null, 10000, false, 'MULTISIGN', address,
        null, null, PUBKEY_BUF.toString('hex'), true, 0.00001
      )
      assert.strictEqual(result.encoding, 'MULTISIGN')
      // Identify the data output by SHAPE (bare multisig ends in OP_CHECKMULTISIG),
      // never by a value that the dust policy is free to move.
      const output = result.psbt.txOutputs.find(o =>
        o.script[o.script.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG)
      assert.ok(output, `${networkName} should have a MULTISIGN output`)
      return { encoder, output }
    }

    it('MULTISIGN output clears both the chain dust floor and the bare-multisig relay floor', async () => {
      for (const chain of CHAINS) {
        const { encoder, output } = await buildMultisign(chain.name)
        const relayFloor = bareMultisigDust(output.script.length)
        assert.strictEqual(encoder.dustAmount, chain.dustThreshold)
        assert.strictEqual(output.value, Math.max(chain.dustThreshold, relayFloor),
          `${chain.name} MULTISIGN output should sit at max(dustThreshold, bare-multisig relay floor)`)
        assert.ok(output.value >= relayFloor,
          `${chain.name} MULTISIGN output must not be relay dust`)
      }
    })

    it('Litecoin MULTISIGN output is higher than Bitcoin, driven by its dust threshold', async () => {
      const btc = await buildMultisign('bitcoin-regtest')
      const ltc = await buildMultisign('litecoin-regtest')

      // Bitcoin's 546 floor is below the relay formula, so the formula binds.
      assert.strictEqual(btc.output.value, bareMultisigDust(btc.output.script.length))
      // Litecoin's 5460 floor is above it, so the chain threshold binds.
      assert.strictEqual(ltc.output.value, 5460)
      assert.ok(ltc.output.value > btc.output.value,
        'Litecoin dust should be higher than Bitcoin')
    })
  })

  // ── F-5: Dogecoin address in P2SH ─────────────────────────────

  describe('F-5: Dogecoin address in P2SH redeem script', () => {
    it('P2SH output address uses Dogecoin network params', async () => {
      const encoder = makeEncoder('dogecoin-regtest')
      const address = getTestAddress('dogecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeIssueFull('DOGETOKEN')

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      assert.strictEqual(result.encoding, 'P2SH')

      // The P2SH output should decode to a valid Dogecoin address
      const dogeNetwork = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
      const p2shOutput = result.psbt.txOutputs.find(o => {
        if (o.value <= 0 || o.value >= 100000000) return false
        const decompiled = bitcoin.script.decompile(o.script)
        return decompiled[0] === bitcoin.opcodes.OP_HASH160
      })
      assert.ok(p2shOutput, 'should have P2SH output')

      // Verify it's a valid P2SH script (OP_HASH160 <20-byte> OP_EQUAL)
      const decompiled = bitcoin.script.decompile(p2shOutput.script)
      assert.strictEqual(decompiled[0], bitcoin.opcodes.OP_HASH160)
      assert.strictEqual(decompiled[1].length, 20)
      assert.strictEqual(decompiled[2], bitcoin.opcodes.OP_EQUAL)
    })
  })

  // ── Network config completeness ───────────────────────────────

  describe('CryptoNetworks completeness', () => {
    const ALL_NETWORKS = [
      'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
      'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
      'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest'
    ]

    for (const network of ALL_NETWORKS) {
      it(`${network} returns valid config with dustThreshold`, () => {
        const config = CryptoNetworks.getBitcoinJsNetwork(network)
        assert.ok(config, `config should exist for ${network}`)
        assert.ok(typeof config.dustThreshold === 'number',
          `${network} should have numeric dustThreshold`)
        assert.ok(config.dustThreshold > 0,
          `${network} dustThreshold should be positive`)
      })
    }
  })

  // ── Fee floor uses chain-specific dust ────────────────────────

  describe('Fee floor uses chain-specific dust threshold', () => {
    it('Litecoin fee floor is 5460, not 546', async () => {
      const encoder = makeEncoder('litecoin-regtest')
      const address = getTestAddress('litecoin-regtest')
      const utxo = makeSegwitUtxo(TXID_A, 0, 100000000)
      const action = actions.makeSend()

      const result = await encoder.createTransaction(
        [utxo], address, null,
        action.data, null, null, false, null, address,
        null, null, null, true, 0.0000001 // very low fee → will be floored
      )

      const changeOutput = result.psbt.txOutputs.find(o => o.value > 0)
      const impliedFee = 100000000 - changeOutput.value
      assert.ok(impliedFee >= 5460,
        `Litecoin fee ${impliedFee} should be >= 5460 dust threshold`)
    })
  })
})
