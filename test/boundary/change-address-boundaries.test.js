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
 * Change Address Boundary Tests
 *
 * Tests the precise changeSatoshis decision logic: exact-match spend (0),
 * minimum positive change (1), dust threshold boundary (546/547 for BTC,
 * 5460/5461 for LTC), negative change, and null change address interactions.
 *
 * Uses explicit `fee` parameter for deterministic control over changeSatoshis:
 *   changeSatoshis = utxoValue - outputSatoshis - fee
 * For OP_RETURN encoding, outputSatoshis = 0, so changeSatoshis = utxoValue - fee.
 */

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const {
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  getTestAddress
} = require('../integration/helpers/utxoFactory')

// BTC semantics: the main-network dust tests assert the 546-sat threshold and
// honor the supplied fee. DOGE dust is 100000 (not 546) and DOGE floors
// sub-100000 fees, so this suite runs on bitcoin-regtest; LTC dust (5460) has
// its own tests below using a local litecoin-regtest encoder.
const NETWORK = 'bitcoin-regtest'
const BTC_DUST = 546
const LTC_DUST = 5460

describe('Change Address Boundaries', () => {

  describe('changeSatoshis = 0 (exact spend)', () => {
    it('no change output added when change is exactly 0', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      // fee = utxoValue → changeSatoshis = 0
      const utxo = makeSegwitUtxo(TXID_A, 0, 10000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(changeOutputs.length, 0,
        'no change output when changeSatoshis = 0')
    })

    it('does not throw even without change address when changeSatoshis = 0', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 10000)

      // change = null, but changeSatoshis = 0 → 0 > dustAmount is false → no throw
      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 10000, false, null, null,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })
  })

  describe('changeSatoshis = 1 (minimum positive change)', () => {
    // M-6: sub-dust change (1..dustAmount-1 sats) is folded into the miner fee,
    // not emitted. A 1-sat output is below every chain's dust threshold and would
    // make the whole transaction unbroadcastable, so the encoder leaves the
    // remainder unclaimed instead of building a dead PSBT.
    it('sub-dust change (value=1) is folded into fee, not emitted, even with a change address', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      // fee = 9999, utxo = 10000 → changeSatoshis = 1 (< 546 dust)
      const utxo = makeSegwitUtxo(TXID_A, 0, 10000)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 9999, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(changeOutputs.length, 0,
        '1-sat change is below dust and must be folded into fee, not emitted')
    })

    it('does not throw with null change when changeSatoshis = 1 (1 <= dustAmount)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 10000)

      // change=null, changeSatoshis=1 → 1 > 546 is false → no throw, but also no output
      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, 9999, false, null, null,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
      const changeOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(changeOutputs.length, 0,
        'no change output when change address is null (even with 1 sat remaining)')
    })
  })

  describe('dust threshold boundary (BTC: 546)', () => {
    it('changeSatoshis = 546 (= dustAmount): no throw with null change', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      // changeSatoshis = 546 → 546 > 546 is false → no throw
      const fee = 10000
      const utxo = makeSegwitUtxo(TXID_A, 0, fee + BTC_DUST)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, fee, false, null, null,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })

    it('changeSatoshis = 547 (dustAmount + 1): throws with null change', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      // changeSatoshis = 547 → 547 > 546 is true → throws
      const fee = 10000
      const utxo = makeSegwitUtxo(TXID_A, 0, fee + BTC_DUST + 1)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'SEND|0|X|1|a', null, fee, false, null, null,
          null, null, null, true, 0.00001
        ),
        /change address/i
      )
    })

    it('changeSatoshis = 547 with change address: creates change output', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const fee = 10000
      const utxo = makeSegwitUtxo(TXID_A, 0, fee + BTC_DUST + 1)

      const result = await encoder.createTransaction(
        [utxo], address, null,
        'SEND|0|X|1|a', null, fee, false, null, address,
        null, null, null, true, 0.00001
      )

      const changeOutputs = result.psbt.txOutputs.filter(o => o.value > 0)
      assert.strictEqual(changeOutputs.length, 1)
      assert.strictEqual(changeOutputs[0].value, BTC_DUST + 1)
    })
  })

  describe('dust threshold boundary (LTC: 5460)', () => {
    it('changeSatoshis = 5460: no throw with null change', async () => {
      const ltcEncoder = makeEncoder('litecoin-regtest')
      const ltcAddress = getTestAddress('litecoin-regtest')
      const fee = 10000
      const utxo = makeSegwitUtxo(TXID_A, 0, fee + LTC_DUST)

      const result = await ltcEncoder.createTransaction(
        [utxo], ltcAddress, null,
        'SEND|0|X|1|a', null, fee, false, null, null,
        null, null, null, true, 0.00001
      )

      assert.ok(result.psbt instanceof bitcoin.Psbt)
    })

    it('changeSatoshis = 5461: throws with null change', async () => {
      const ltcEncoder = makeEncoder('litecoin-regtest')
      const ltcAddress = getTestAddress('litecoin-regtest')
      const fee = 10000
      const utxo = makeSegwitUtxo(TXID_A, 0, fee + LTC_DUST + 1)

      await assert.rejects(
        () => ltcEncoder.createTransaction(
          [utxo], ltcAddress, null,
          'SEND|0|X|1|a', null, fee, false, null, null,
          null, null, null, true, 0.00001
        ),
        /change address/i
      )
    })
  })

  // Inputs cannot cover outputs + fee. The encoder must throw a typed
  // INSUFFICIENT_FUNDS error rather than return an unbroadcastable PSBT whose
  // outputs exceed its inputs (the pre-M-8 behavior returned it silently).

  describe('negative changeSatoshis', () => {
    it('throws INSUFFICIENT_FUNDS when fee exceeds input (change address present)', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      // utxo = 1000, fee = 5000 → changeSatoshis = -4000
      const utxo = makeSegwitUtxo(TXID_A, 0, 1000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'SEND|0|X|1|a', null, 5000, false, null, address,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true &&
                 err.xchainCode === 'INSUFFICIENT_FUNDS' &&
                 err.details.available === 1000 &&
                 err.details.required === 5000
      )
    })

    it('throws INSUFFICIENT_FUNDS with a null change address too', async () => {
      const encoder = makeEncoder(NETWORK)
      const address = getTestAddress(NETWORK)
      const utxo = makeSegwitUtxo(TXID_A, 0, 1000)

      await assert.rejects(
        () => encoder.createTransaction(
          [utxo], address, null,
          'SEND|0|X|1|a', null, 5000, false, null, null,
          null, null, null, true, 0.00001
        ),
        (err) => err.operational === true && err.xchainCode === 'INSUFFICIENT_FUNDS'
      )
    })
  })
})
