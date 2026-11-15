// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A base58 script-hash caller identity carries HASH160(redeemScript), which no
// key satisfies as the chunk lane's P2PKH gate, so it is refused as caller input.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const coins = require('../../../src/coins')
const { resolveCallerHash160 } = require('../../../src/XChainEncoder/request_resolution.js')
const { PUBKEY_BUF, makeEncoder } = require('../../integration/helpers/utxoFactory')

const HASH = bitcoin.crypto.hash160(PUBKEY_BUF)

function isScriptHashRefusal (err) {
  return err instanceof TypeError && err.invalidParams === true && /script-hash \(P2SH\) address/.test(err.message)
}

function everyNetwork () {
  const rows = []
  for (const [full, tick] of Object.entries(coins.FULL_NAME_TO_TICK)) {
    for (const net of coins.NETWORKS) rows.push({ key: `${full}-${net}`, params: coins.getCoinConfig(tick, net).net })
  }
  return rows
}

describe('caller identity: base58 script-hash addresses are refused', () => {
  it('refuses a P2SH address minted for any supported coin and network', () => {
    const rows = everyNetwork()
    assert.ok(rows.length >= 9)
    for (const { key, params } of rows) {
      const p2sh = bitcoin.address.toBase58Check(HASH, params.scriptHash)
      assert.throws(() => resolveCallerHash160(p2sh), isScriptHashRefusal, key)
    }
  })

  it('still resolves a P2PKH address minted for any supported coin and network to HASH160(pubkey)', () => {
    for (const { key, params } of everyNetwork()) {
      const p2pkh = bitcoin.address.toBase58Check(HASH, params.pubKeyHash)
      assert.deepStrictEqual(Buffer.from(resolveCallerHash160(p2pkh)), Buffer.from(HASH), key)
    }
  })

  it('keeps pubKeyHash and scriptHash version bytes disjoint, which the refusal relies on', () => {
    const pubKeyHash = new Set(everyNetwork().map((r) => r.params.pubKeyHash))
    for (const { params } of everyNetwork()) assert.ok(!pubKeyHash.has(params.scriptHash), String(params.scriptHash))
  })

  it('refuses the P2SH identity on the chunk lane before any gate script is built', () => {
    const encoder = makeEncoder('bitcoin-regtest')
    const p2sh = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey: PUBKEY_BUF, network: bitcoin.networks.regtest }),
      network: bitcoin.networks.regtest
    }).address
    for (const encoding of ['P2SH', 'P2WSH']) {
      assert.throws(() => encoder.prepareData(Buffer.alloc(200), encoding, p2sh), isScriptHashRefusal, encoding)
    }
  })
})
