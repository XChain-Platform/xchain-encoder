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

// The tracker's JSON-RPC error text reaches public create_tx and get_utxos errors,
// so it must arrive leak-checked, printable and capped, like halt_reason.
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
    assert.strictEqual(msg, 'Error getting utxos: [-32000] boom')
  })

  it('caps a long tracker message at 120 characters', async () => {
    const msg = await trackerErrorMessage({ message: 'x'.repeat(1000) })
    assert.strictEqual(msg, 'Error getting utxos: ' + 'x'.repeat(120))
  })

  it('drops an oversized tracker message to the generic text', async () => {
    const msg = await trackerErrorMessage({ message: 'y'.repeat(5000) })
    assert.strictEqual(msg, 'Error getting utxos: unknown error')
  })

  it('replaces control characters in the tracker message', async () => {
    const msg = await trackerErrorMessage({ message: 'line1\nline2\r\u0000end' })
    assert.ok(!/[^\x20-\x7e]/.test(msg), 'control characters survived: ' + JSON.stringify(msg))
    assert.match(msg, /^Error getting utxos: line1 line2/)
  })

  it('cleans or drops a hostile string code and keeps the message', async () => {
    const msg = await trackerErrorMessage({ message: 'busy', data: { code: 'z'.repeat(5000) } })
    assert.strictEqual(msg, 'Error getting utxos: busy')
    const ctl = await trackerErrorMessage({ message: 'busy', data: { code: 'BAD\nCODE' } })
    assert.strictEqual(ctl, 'Error getting utxos: [BAD CODE] busy')
  })

  it('reads a non-string message as unknown error, not [object Object]', async () => {
    const msg = await trackerErrorMessage({ code: -1, message: { nested: true } })
    assert.strictEqual(msg, 'Error getting utxos: [-1] unknown error')
  })

  it('drops a tracker message that names an internal endpoint', async () => {
    const msg = await trackerErrorMessage({ message: 'upstream tracker-db:3306 refused' })
    assert.strictEqual(msg, 'Error getting utxos: unknown error')
  })
})
