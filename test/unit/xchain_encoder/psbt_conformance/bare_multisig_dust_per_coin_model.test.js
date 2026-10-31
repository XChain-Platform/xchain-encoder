// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Each coin sizes the bare-multisig carrier from its own relay dust model: Bitcoin and
// Litecoin per byte, Dogecoin at its flat hard limit (the pinned dustThreshold). The
// forced-low outputFloor case proves the Dogecoin carrier does not lean on that floor.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { bareMultisigRelayDustFor } = require('../../../../src/XChainEncoder/script_amount_helpers.js')
const { PUBKEY_HEX, paymentFor, utxoFor, makeEncoder, build } = require('../../../helpers/psbt_build_fixtures.js')

const ONE_OF_THREE_SCRIPT_BYTES = 105

describe('XChainEncoder bare-multisig carrier dust names a model for every coin', function () {
  it('prices Bitcoin and Litecoin per byte at their node relay rates', function () {
    assert.strictEqual(bareMultisigRelayDustFor('bitcoin-regtest', ONE_OF_THREE_SCRIPT_BYTES, 546), 786)
    assert.strictEqual(bareMultisigRelayDustFor('litecoin-regtest', ONE_OF_THREE_SCRIPT_BYTES, 5460), 7860)
  })

  for (const network of ['dogecoin-regtest', 'dogecoin-testnet', 'dogecoin-mainnet']) {
    it(`${network}: takes the flat hard limit, not a per-byte rate`, function () {
      assert.strictEqual(bareMultisigRelayDustFor(network, ONE_OF_THREE_SCRIPT_BYTES, 100000), 100000)
    })
  }

  it('refuses a network key with no dust model instead of borrowing another coin rate', function () {
    assert.throws(() => bareMultisigRelayDustFor('examplecoin-regtest', ONE_OF_THREE_SCRIPT_BYTES, 546),
      /No dust relay model for network examplecoin-regtest/)
  })

  it('keeps a Dogecoin carrier at the hard limit when the output floor is forced below it', async function () {
    const prevTxs = new Map()
    const encoder = makeEncoder('dogecoin-regtest', { estimate: 0.01, relayfee: 0.001, prevTxs })
    encoder.outputFloor = 1
    const pay = paymentFor('p2pkh', 'dogecoin-regtest')
    const result = await build(encoder, {
      utxos: [utxoFor(prevTxs, pay.output, 100000000000, 'ms-dust-model:dogecoin-regtest')], pubkey: pay.address,
      data: 'FILE|0|b.bin|application/octet-stream|' + 'A'.repeat(300), encoding: 'MULTISIGN',
      change: pay.address, compressedPubKey: PUBKEY_HEX
    })
    assert.strictEqual(result.encoding, 'MULTISIGN')
    const outs = result.psbt.txOutputs.filter(o => o.script[o.script.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG)
    assert.ok(outs.length >= 2, 'the payload spans several multisig outputs')
    for (const o of outs) {
      assert.strictEqual(o.script.length, ONE_OF_THREE_SCRIPT_BYTES, 'a 1-of-3 compressed-key script')
      assert.strictEqual(Number(o.value), 100000)
    }
  })
})
