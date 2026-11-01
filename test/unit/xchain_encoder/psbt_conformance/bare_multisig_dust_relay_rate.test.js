// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A bare 1-of-3 multisig carrier output is sized at the coin's own dust relay rate.
// Litecoin Core relays dust at 30000 litoshi/kB (src/policy/policy.h DUST_RELAY_TX_FEE),
// ten times Bitcoin Core's 3000 sat/kB, so the 262-byte output-plus-spend is 7860
// litoshi there; the chain's flat 5460 P2PKH threshold sits under it and is relay dust.
// Bitcoin and Dogecoin values are pinned byte for byte.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { PUBKEY_HEX, paymentFor, utxoFor, makeEncoder, build } = require('../../../helpers/psbt_build_fixtures.js')

const CASES = [
  { network: 'bitcoin-regtest', kind: 'p2wpkh', estimate: 0.00001, relayfee: 0.00001, value: 100000000, expected: 786 },
  { network: 'litecoin-regtest', kind: 'p2wpkh', estimate: 0.0001, relayfee: 0.0001, value: 100000000, expected: 7860 },
  { network: 'dogecoin-regtest', kind: 'p2pkh', estimate: 0.01, relayfee: 0.001, value: 100000000000, expected: 1000000 }
]

async function multisigValues (c) {
  const prevTxs = new Map()
  const encoder = makeEncoder(c.network, { estimate: c.estimate, relayfee: c.relayfee, prevTxs })
  const pay = paymentFor(c.kind, c.network)
  const result = await build(encoder, {
    utxos: [utxoFor(prevTxs, pay.output, c.value, 'ms-dust:' + c.network)], pubkey: pay.address,
    data: 'FILE|0|b.bin|application/octet-stream|' + 'A'.repeat(300), encoding: 'MULTISIGN',
    change: pay.address, compressedPubKey: PUBKEY_HEX
  })
  assert.strictEqual(result.encoding, 'MULTISIGN')
  const outs = result.psbt.txOutputs.filter(o => o.script[o.script.length - 1] === bitcoin.opcodes.OP_CHECKMULTISIG)
  assert.ok(outs.length >= 2, 'the payload spans several multisig outputs')
  return outs
}

describe('XChainEncoder bare-multisig carrier dust per coin relay rate', function () {
  for (const c of CASES) {
    it(`${c.network}: every multisig carrier output is ${c.expected}`, async function () {
      const outs = await multisigValues(c)
      for (const o of outs) {
        assert.strictEqual(o.script.length, 105, 'a 1-of-3 compressed-key script')
        assert.strictEqual(Number(o.value), c.expected)
      }
    })
  }
})
