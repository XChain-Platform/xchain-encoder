// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The P2SH two-phase funding leg was sized at
// max(per-chunk fee share, dust floor), which on Dogecoin (dust 100000 koinu)
// left the phase-2 reveal unable to leave a single output: its whole leg went
// to miner fee, the SDK's FULL_BURN_FEE guard (correctly) refused to sign, and
// the confirmed phase-1 commit was stranded. The fix tops the FIRST leg up by
// the reveal's own whole-tx fee (estimateP2shRevealTx, shared by both phases)
// plus one dust, and the reveal sweeps the surplus back to the caller as a
// change output. These tests pin:
//   - the DOGE two-phase leg now covers the reveal's fee plus its change;
//   - the reveal is no longer a full burn (leaves a >= dust output);
//   - the leg scales with fee rate and with payload size;
//   - BTC/LTC default two-phase (P2WSH) funding AND reveal transactions are
//     BYTE-IDENTICAL to the pre-fix encoder (reference hexes generated from
//     the pristine git-HEAD module with this exact harness), as is the DOGE
//     single-phase OP_RETURN path;
//   - a legacy (pre-fix, headroomless) funding leg still produces the exact
//     pre-fix outputless reveal, so old stranded commits replay unchanged.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const CryptoNetworks = require('../../src/CryptoNetworks')

const SATOSHI_UNIT = 100000000
const pubkeyBuf = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const TXID_A = 'a'.repeat(64)

function makeSegwitUtxo (txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: pubkeyBuf,
    network: bitcoin.networks.regtest
  })
  return {
    txid,
    vout,
    value,
    confirmations: 6,
    scriptPubKey: p2wpkh.output.toString('hex')
  }
}

function makeEncoder (network) {
  const encoder = new XChainEncoder(
    network, '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  // 0.01 coin/kB node estimate: a DOGE-plausible rate that keeps the
  // relative fee cap (x100) far above every caller rate used here.
  encoder.connector = {
    getFeePerKilobyte: async () => 0.01,
    getTransactionHex: async () => { throw new Error('not needed by these tests') }
  }
  return encoder
}

function callerAddress (network) {
  const net = CryptoNetworks.getBitcoinJsNetwork(network)
  return bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network: net }).address
}

async function buildFunding (encoder, network, encoding, feePerKb, payloadLen) {
  const addr = callerAddress(network)
  const res = await encoder.createTransaction(
    [makeSegwitUtxo(TXID_A, 0, 100000000)], addr, null,
    'x'.repeat(payloadLen), null, null, false, encoding, addr,
    null, null, null, true, feePerKb
  )
  return res.psbt.__CACHE.__TX
}

async function buildReveal (encoder, network, encoding, feePerKb, payloadLen, fundingTx) {
  const addr = callerAddress(network)
  const res = await encoder.createTransaction(
    [], addr, null,
    'x'.repeat(payloadLen), null, null, false, encoding, addr,
    fundingTx.getId(), fundingTx.toHex(), null, true, feePerKb
  )
  return res.psbt.__CACHE.__TX
}

function legOutputs (tx) {
  // P2SH scriptPubKey: a914{20-byte hash}87
  return tx.outs.filter(o => {
    const hex = o.script.toString('hex')
    return hex.startsWith('a914') && hex.endsWith('87')
  })
}

const DOGE = 'dogecoin-regtest'
const DOGE_DUST = 100000
const VENUE_RATE_KB = 1000000 // 1000 koinu/byte, the venue recipe rate

describe('XChainEncoder P2SH reveal headroom', () => {
  it('funds the DOGE leg to cover the reveal fee plus the change it must leave', async () => {
    const encoder = makeEncoder(DOGE)
    const payloadLen = 120
    const funding = await buildFunding(encoder, DOGE, 'P2SH', VENUE_RATE_KB, payloadLen)
    const legs = legOutputs(funding)
    assert.strictEqual(legs.length, 1, 'single chunk expected for this payload')
    const legTotal = legs.reduce((s, o) => s + o.value, 0)

    const reveal = await buildReveal(encoder, DOGE, 'P2SH', VENUE_RATE_KB, payloadLen, funding)
    const totalOut = reveal.outs.reduce((s, o) => s + o.value, 0)
    const revealFeePaid = legTotal - totalOut

    // The reveal's whole-tx fee at the caller rate, as both phases price it
    // (43 = worst-case change output reserve).
    const feePerBytes = VENUE_RATE_KB / 1000 / SATOSHI_UNIT
    const dataChunks = reveal.ins.length // one redeem chunk per reveal input
    assert.ok(dataChunks >= 1)
    // The leg must cover the reveal's priced fee plus one dust for the swept
    // change output.
    assert.ok(
      legTotal >= revealFeePaid + DOGE_DUST,
      `leg ${legTotal} must cover reveal fee ${revealFeePaid} + dust ${DOGE_DUST}`
    )
    // And the fee actually paid is a real per-byte fee, not the dust floor
    // accident: at 1000 koinu/byte a ~300-byte reveal prices well over dust.
    assert.ok(revealFeePaid > DOGE_DUST,
      `reveal fee ${revealFeePaid} should exceed the dust floor at the venue rate`)
  })

  it('the DOGE reveal is no longer a full burn: it leaves a >= dust output to the caller', async () => {
    const encoder = makeEncoder(DOGE)
    const funding = await buildFunding(encoder, DOGE, 'P2SH', VENUE_RATE_KB, 120)
    const reveal = await buildReveal(encoder, DOGE, 'P2SH', VENUE_RATE_KB, 120, funding)

    const totalOut = reveal.outs.reduce((s, o) => s + o.value, 0)
    // This is EXACTLY the SDK guard's FULL_BURN_FEE condition
    // (reconcileEncoded: totalIn > 0 && totalOut === 0). It must not hold.
    assert.ok(totalOut > 0, 'reveal burns every satoshi to miners (FULL_BURN_FEE would refuse to sign)')

    const callerScript = bitcoin.payments.p2pkh({
      pubkey: pubkeyBuf,
      network: CryptoNetworks.getBitcoinJsNetwork(DOGE)
    }).output
    const sweep = reveal.outs.find(o => o.script.equals(callerScript))
    assert.ok(sweep, 'the surplus must return to the caller address')
    assert.ok(sweep.value >= DOGE_DUST, `sweep ${sweep && sweep.value} must be at least dust ${DOGE_DUST}`)
  })

  it('funds dust-dominant legs with exactly one extra dust of headroom (tiny fee rate)', async () => {
    const encoder = makeEncoder(DOGE)
    // 1 koinu/byte: every size-based estimate is far below the 100000 dust
    // floor, so pre-fix the leg was exactly one dust. Now it is dust (leg
    // floor) + dust (reveal change headroom); the reveal keeps one dust as
    // its (dust-floored) fee and sweeps the other back.
    const funding = await buildFunding(encoder, DOGE, 'P2SH', 1000, 120)
    const legs = legOutputs(funding)
    assert.strictEqual(legs.length, 1)
    assert.strictEqual(legs[0].value, 2 * DOGE_DUST)

    const reveal = await buildReveal(encoder, DOGE, 'P2SH', 1000, 120, funding)
    const totalOut = reveal.outs.reduce((s, o) => s + o.value, 0)
    assert.strictEqual(totalOut, DOGE_DUST, 'exactly one dust sweeps back; one dust stays as the reveal fee')
  })

  it('scales the leg with the fee rate and with the payload size', async () => {
    const encoder = makeEncoder(DOGE)
    const legAt = async (rateKb, payloadLen) => {
      const funding = await buildFunding(encoder, DOGE, 'P2SH', rateKb, payloadLen)
      return legOutputs(funding).reduce((s, o) => s + o.value, 0)
    }
    const base = await legAt(VENUE_RATE_KB, 120)
    const doubleRate = await legAt(2 * VENUE_RATE_KB, 120)
    const biggerPayload = await legAt(VENUE_RATE_KB, 400)
    assert.ok(doubleRate > base, `leg must grow with the fee rate (${doubleRate} vs ${base})`)
    assert.ok(biggerPayload > base, `leg must grow with the payload (${biggerPayload} vs ${base})`)
  })

  it('replays a legacy (pre-fix, headroomless) funding leg into the exact pre-fix outputless reveal', async () => {
    const encoder = makeEncoder(DOGE)
    const funding = await buildFunding(encoder, DOGE, 'P2SH', VENUE_RATE_KB, 120)
    // Rebuild the funding tx with the leg at its PRE-FIX value: exactly one
    // dust (100000 koinu), the adjudicated totalIn of every stranded commit
    // observed on the venue. No headroom exists, so the fixed
    // reveal builder must reproduce the pre-fix reveal byte shape rather than
    // invent an unfundable change output.
    const legacy = bitcoin.Transaction.fromHex(funding.toHex())
    const legIndex = legacy.outs.findIndex(o => o.script.toString('hex').startsWith('a914'))
    assert.ok(legIndex >= 0)
    legacy.outs[legIndex].value = DOGE_DUST
    const reveal = await buildReveal(encoder, DOGE, 'P2SH', VENUE_RATE_KB, 120, legacy)
    // Pre-fix shape: the OP_RETURN marker is the ONLY output, value zero.
    assert.strictEqual(reveal.outs.length, 1)
    assert.strictEqual(reveal.outs[0].value, 0)
    assert.ok(reveal.outs[0].script.toString('hex').startsWith('6a'))
  })

  // Byte-identity pins for the paths that already work today. The expected
  // hexes were generated with THIS harness against the pre-fix (git HEAD)
  // XChainEncoder, so any drift on these lanes fails loudly.
  const PRE_FIX = {
    btcP2wshFunding: '0200000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000ffffffff02020900000000000022002050efb27b1cb5812e1bb95788a3ffd8550464371c1d57a36e4649e9b5ae8ed1fefbd1f505000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000',
    ltcP2wshFunding: '0200000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000ffffffff02405b00000000000022002050efb27b1cb5812e1bb95788a3ffd8550464371c1d57a36e4649e9b5ae8ed1fe9849f505000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000',
    btcP2wshReveal: '02000000019d2de3ed9219bd7f9df123398722dac29eef5f38d5c5b038a96dc6678a7066fd0000000000ffffffff0200000000000000000b6a098163302df9a1af23ee22020000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000',
    ltcP2wshReveal: '0200000001e681017eda2e84c8f80a5d543af89041236fc9e7549630025e3d1588ef60e5c60000000000ffffffff0200000000000000000b6a09e56b6a299a4ddadb6654150000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000',
    dogeOpReturn: '0200000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000ffffffff0200000000000000002f6a2d09cb8e09635af4c5aa3a916a26c6652b18482f3a1ec3636bebdfa9f4d1599a8385426040f9baaff90aa6b137f0a854f305000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000'
  }

  it('keeps the BTC default two-phase lane (P2WSH) byte-identical, funding and reveal', async () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const funding = await buildFunding(encoder, 'bitcoin-regtest', 'P2WSH', 10000, 200)
    assert.strictEqual(funding.toHex(), PRE_FIX.btcP2wshFunding)
    const reveal = await buildReveal(encoder, 'bitcoin-regtest', 'P2WSH', 10000, 200, funding)
    assert.strictEqual(reveal.toHex(), PRE_FIX.btcP2wshReveal)
  })

  it('keeps the LTC default two-phase lane (P2WSH) byte-identical, funding and reveal', async () => {
    const encoder = makeEncoder('litecoin-regtest')
    const funding = await buildFunding(encoder, 'litecoin-regtest', 'P2WSH', 100000, 200)
    assert.strictEqual(funding.toHex(), PRE_FIX.ltcP2wshFunding)
    const reveal = await buildReveal(encoder, 'litecoin-regtest', 'P2WSH', 100000, 200, funding)
    assert.strictEqual(reveal.toHex(), PRE_FIX.ltcP2wshReveal)
  })

  it('keeps the DOGE single-phase OP_RETURN path byte-identical', async () => {
    const encoder = makeEncoder(DOGE)
    const funding = await buildFunding(encoder, DOGE, 'OP_RETURN', VENUE_RATE_KB, 40)
    assert.strictEqual(funding.toHex(), PRE_FIX.dogeOpReturn)
  })
})
