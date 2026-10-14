// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A P2WSH action of two or more chunks has no floor pad on its reveal, so the reveal
// leaves a value output only if its legs carry more than its fee. The first leg is
// topped up to the whole reveal's fee plus one output floor, and the reveal sweeps
// the surplus back to the caller: never a lone zero-value OP_RETURN, which the
// signer refuses as a full burn after the commit is already on chain.

const assert = require('assert')
const { PUBKEY, paymentFor, utxoFor, makeEncoder, build, unsignedTx } = require('../../../helpers/psbt_build_fixtures.js')

const FEE_PER_KB = 2000 // base units per kB: 2 per vbyte

async function fundAndReveal (network, payloadLength) {
  const prevTxs = new Map()
  const encoder = makeEncoder(network, { estimate: 0.00002, relayfee: 0.00001, prevTxs })
  const pay = paymentFor('p2wpkh', network)
  const data = 'x'.repeat(payloadLength)
  const funding = await build(encoder, {
    utxos: [utxoFor(prevTxs, pay.output, 5000000, network + payloadLength)], pubkey: pay.address,
    data, encoding: 'P2WSH', change: pay.address, feePerKb: FEE_PER_KB
  })
  const fundingTx = unsignedTx(funding)
  const reveal = await build(encoder, {
    utxos: [], pubkey: pay.address, data, encoding: 'P2WSH', change: pay.address,
    p2shHash: fundingTx.getId(), p2shHex: fundingTx.toHex(), feePerKb: FEE_PER_KB
  })
  return { encoder, pay, fundingTx, reveal }
}

// The reveal's vsize once signed: a 72-byte signature, the key and the witness script per input.
function signedRevealVsize (reveal) {
  const tx = unsignedTx(reveal)
  reveal.psbt.data.inputs.forEach((input, i) => {
    tx.ins[i].witness = [Buffer.alloc(72, 1), PUBKEY, input.witnessScript]
  })
  return tx.virtualSize()
}

function legTotal (reveal) {
  return reveal.psbt.data.inputs.reduce((sum, input) => sum + BigInt(input.witnessUtxo.value), 0n)
}

describe('XChainEncoder multi-chunk P2WSH reveal headroom', function () {
  for (const network of ['bitcoin-regtest', 'litecoin-regtest']) {
    for (const payloadLength of [600, 1500]) {
      it(`${network} ${payloadLength}-byte payload: the reveal returns change at or above the output floor`, async function () {
        const { encoder, pay, reveal } = await fundAndReveal(network, payloadLength)
        assert.ok(reveal.psbt.data.inputs.length >= 2, 'the payload spans at least two chunks')
        const change = reveal.psbt.txOutputs.filter(o => o.script.equals(pay.output))
        assert.strictEqual(change.length, 1, 'one change output back to the caller')
        assert.ok(BigInt(change[0].value) >= BigInt(encoder.outputFloor),
          `change ${change[0].value} is under the output floor ${encoder.outputFloor}`)
      })

      it(`${network} ${payloadLength}-byte payload: the reveal still pays its target rate on its signed size`, async function () {
        const { reveal } = await fundAndReveal(network, payloadLength)
        let outputs = 0n
        for (const out of reveal.psbt.txOutputs) outputs += BigInt(out.value)
        const fee = legTotal(reveal) - outputs
        const needed = BigInt(Math.ceil(signedRevealVsize(reveal) * FEE_PER_KB / 1000))
        assert.ok(fee >= needed, `reveal fee ${fee} is under ${needed} for its signed size`)
      })
    }
  }
})
