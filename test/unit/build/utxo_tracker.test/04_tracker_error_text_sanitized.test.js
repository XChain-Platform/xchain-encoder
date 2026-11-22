// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const { axios, installAxiosHooks, makeTracker } = require('./helpers/support')

const ADDRESS = 'mhqpGkU1tUYKFrmtFDXEcBiMqzaZTbEPxX'

// Tracker codes select fixed encoder-written text; tracker prose is never public.
async function trackerErrorMessage(error) {
  let callCount = 0
  axios.post = async () => {
    callCount++
    if (callCount === 1) return { data: { result: { lag: 0, synced: true } } }
    return { data: { error } }
  }
  try {
    await makeTracker().getUtxosFromAddress(ADDRESS)
  } catch (err) {
    return err.message
  }
  throw new Error('expected getUtxosFromAddress to reject')
}

describe('UtxoTracker.getUtxosFromAddress() tracker error text', () => {
  installAxiosHooks()

  it('keeps a normal tracker code and message unchanged', async () => {
    const msg = await trackerErrorMessage({ message: 'address has too many utxos', data: { code: 'ADDRESS_TOO_LARGE' } })
    assert.strictEqual(msg, 'Error getting utxos: [ADDRESS_TOO_LARGE] address has too many utxos')
  })

  it('keeps a numeric JSON-RPC code', async () => {
    const msg = await trackerErrorMessage({ code: -32000, message: 'boom' })
    assert.strictEqual(msg, 'Error getting utxos: [-32000] utxo-tracker refused the request')
  })

  it('caps a long tracker message at 120 characters', async () => {
    const msg = await trackerErrorMessage({ message: 'x'.repeat(1000) })
    assert.strictEqual(msg, 'Error getting utxos: utxo-tracker refused the request')
  })

  it('drops an oversized tracker message to the generic text', async () => {
    const msg = await trackerErrorMessage({ message: 'y'.repeat(5000) })
    assert.strictEqual(msg, 'Error getting utxos: utxo-tracker refused the request')
  })

  it('replaces control characters in the tracker message', async () => {
    const msg = await trackerErrorMessage({ message: 'line1\nline2\r\u0000end' })
    assert.ok(!/[^\x20-\x7e]/.test(msg), 'control characters survived: ' + JSON.stringify(msg))
    assert.strictEqual(msg, 'Error getting utxos: utxo-tracker refused the request')
  })

  it('cleans or drops a hostile string code and keeps the message', async () => {
    const msg = await trackerErrorMessage({ message: 'busy', data: { code: 'z'.repeat(5000) } })
    assert.strictEqual(msg, 'Error getting utxos: utxo-tracker refused the request')
    const ctl = await trackerErrorMessage({ message: 'busy', data: { code: 'BAD\nCODE' } })
    assert.strictEqual(ctl, 'Error getting utxos: utxo-tracker refused the request')
  })

  it('reads a non-string message as unknown error, not [object Object]', async () => {
    const msg = await trackerErrorMessage({ code: -1, message: { nested: true } })
    assert.strictEqual(msg, 'Error getting utxos: [-1] utxo-tracker refused the request')
  })

  it('drops a tracker message that names an internal endpoint', async () => {
    const msg = await trackerErrorMessage({ message: 'upstream tracker-db:3306 refused' })
    assert.strictEqual(msg, 'Error getting utxos: utxo-tracker refused the request')
  })

  it('drops a well-formed tracker code the encoder does not know', async () => {
    for (const error of [
      { code: -32602, message: 'refused', data: { code: 'RPCPASSWORD_SECRET' } },
      { code: 1234567890123, message: 'refused' }
    ]) {
      const msg = await trackerErrorMessage(error)
      assert.strictEqual(msg, 'Error getting utxos: utxo-tracker refused the request')
    }
    const known = await trackerErrorMessage({ code: -32602, message: 'cursor is bad', data: { code: 'INVALID_CURSOR' } })
    assert.strictEqual(known, 'Error getting utxos: [INVALID_CURSOR] invalid pagination cursor')
  })
})
