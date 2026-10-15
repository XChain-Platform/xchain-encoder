// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A chunk reveal spends the funding outputs with the scripts rebuilt from the reveal
// call's own payload. When that payload differs from the funded one at the same chunk
// count, the scripts do not hash to the outputs they claim to spend and the reveal can
// never be valid, so the encoder refuses it instead of returning an unspendable PSBT.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { paymentFor, utxoFor, makeEncoder, build, unsignedTx } = require('../../../helpers/psbt_build_fixtures.js')

const FEE_PER_KB = 2000

async function fund (network, encoding, data) {
  const prevTxs = new Map()
  const encoder = makeEncoder(network, { estimate: 0.00002, relayfee: 0.00001, prevTxs })
  const pay = paymentFor('p2wpkh', network)
  const funding = await build(encoder, {
    utxos: [utxoFor(prevTxs, pay.output, 5000000, network + encoding + data.length)], pubkey: pay.address,
    data, encoding, change: pay.address, feePerKb: FEE_PER_KB
  })
  return { encoder, pay, fundingTx: unsignedTx(funding) }
}

function reveal (encoder, pay, fundingTx, encoding, data) {
  return build(encoder, {
    utxos: [], pubkey: pay.address, data, encoding, change: pay.address,
    p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex(), feePerKb: FEE_PER_KB
  })
}

describe('XChainEncoder chunk reveal refuses scripts that do not match the funded outputs', function () {
  for (const encoding of ['P2SH', 'P2WSH']) {
    for (const length of [100, 600, 1500]) {
      it(`${encoding} ${length}-byte payload: a reveal of the funded payload is built`, async function () {
        const data = 'x'.repeat(length)
        const { encoder, pay, fundingTx } = await fund('bitcoin-regtest', encoding, data)
        const r = await reveal(encoder, pay, fundingTx, encoding, data)
        const tx = unsignedTx(r)
        for (const input of tx.ins) assert.strictEqual(Buffer.from(input.hash).reverse().toString('hex'), fundingTx.getId())
      })

      it(`${encoding} ${length}-byte payload: a reveal of a different same-length payload is refused`, async function () {
        const { encoder, pay, fundingTx } = await fund('bitcoin-regtest', encoding, 'x'.repeat(length))
        await assert.rejects(reveal(encoder, pay, fundingTx, encoding, 'y'.repeat(length)),
          (err) => err instanceof RangeError && /does not match the funded output/.test(err.message))
      })
    }
  }

  it('P2WSH: a reveal whose payload needs more chunks than were funded is refused', async function () {
    const { encoder, pay, fundingTx } = await fund('bitcoin-regtest', 'P2WSH', 'x'.repeat(600))
    const fundedLegs = fundingTx.outs.filter(o => {
      const d = bitcoin.script.decompile(o.script)
      return d && d.length === 2 && d[0] === bitcoin.opcodes.OP_0 && d[1].length === 32
    }).length
    assert.ok(fundedLegs >= 2)
    await assert.rejects(reveal(encoder, pay, fundingTx, 'P2WSH', 'x'.repeat(1500)), RangeError)
  })
})
