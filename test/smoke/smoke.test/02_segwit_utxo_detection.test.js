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
 * Smoke Tests: xchain-encoder
 *
 * Fast health-check suite that verifies the encoder's core building blocks
 * are operational. No coin node, no network calls, no external services.
 *
 * Run: npm run smoke-test
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib');
const XChainEncoder = require('../../../src/XChainEncoder');

describe('S8: Segwit UTXO Detection', () => {

  const PUBKEY_BUF = Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex'
  )

  let encoder
  before(() => {
    encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', '')
  })

  it('P2WPKH scriptPubKey → true', () => {
    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey: PUBKEY_BUF,
      network: bitcoin.networks.regtest
    })
    assert.strictEqual(
      encoder.isSegwitUTXO({ scriptPubKey: p2wpkh.output.toString('hex') }),
      true
    )
  })

  it('P2PKH scriptPubKey → false', () => {
    const p2pkh = bitcoin.payments.p2pkh({
      pubkey: PUBKEY_BUF,
      network: bitcoin.networks.regtest
    })
    assert.strictEqual(
      encoder.isSegwitUTXO({ scriptPubKey: p2pkh.output.toString('hex') }),
      false
    )
  })

  it('P2SH scriptPubKey → false', () => {
    const p2sh = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({
        pubkey: PUBKEY_BUF,
        network: bitcoin.networks.regtest
      }),
      network: bitcoin.networks.regtest
    })
    assert.strictEqual(
      encoder.isSegwitUTXO({ scriptPubKey: p2sh.output.toString('hex') }),
      false
    )
  })

  it('invalid scriptPubKey → false (no throw)', () => {
    assert.strictEqual(
      encoder.isSegwitUTXO({ scriptPubKey: 'zzzz' }),
      false
    )
  })
})
