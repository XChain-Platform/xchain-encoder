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
const axios = require('axios')
const UtxoTracker = require('../../../src/build/utxo_tracker')

const ADDRESS = 'mhqpGkU1tUYKFrmtFDXEcBiMqzaZTbEPxX'
const ENV_NAME = 'XCHAIN_MAX_ADDRESS_UTXOS'

function utxo (vout) {
  return {
    txid: String(vout + 1).padStart(64, '0'),
    vout,
    value: 50000000,
    scriptPubKey: '76a914' + 'ab'.repeat(20) + '88ac',
    confirmations: 6
  }
}

describe('UtxoTracker constructor', () => {
  it('builds the correct URL from host and port', () => {
    const t = new UtxoTracker('myhost', 12345)
    assert.strictEqual(t.url, 'http://myhost:12345')
  })

  it('stores the port', () => {
    const t = new UtxoTracker('h', 9999)
    assert.strictEqual(t.port, 9999)
  })
})

describe('UtxoTracker public result cap', () => {
  let originalPost
  let originalCap

  beforeEach(() => {
    originalPost = axios.post
    originalCap = process.env[ENV_NAME]
  })

  afterEach(() => {
    axios.post = originalPost
    if (originalCap === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = originalCap
  })

  function stubPages (pages, requestedLimits) {
    let call = 0
    axios.post = async (url, payload) => {
      if (call++ === 0) return { data: { result: { lag: 0, synced: true } } }
      requestedLimits.push(payload.params.limit)
      return { data: { result: pages.shift() } }
    }
  }

  it('returns a complete set at exactly the configured cap', async () => {
    process.env[ENV_NAME] = '2'
    const limits = []
    stubPages([{ utxos: [utxo(0), utxo(1)] }], limits)

    const result = await new UtxoTracker('127.0.0.1', 18420).getUtxosFromAddress(ADDRESS)

    assert.strictEqual(result.utxos.length, 2)
    assert.deepStrictEqual(limits, [3])
  })

  it('refuses a set above the configured cap without returning a partial set', async () => {
    process.env[ENV_NAME] = '2'
    const limits = []
    stubPages([{ utxos: [utxo(0), utxo(1), utxo(2)] }], limits)

    await assert.rejects(
      () => new UtxoTracker('127.0.0.1', 18420).getUtxosFromAddress(ADDRESS),
      err => {
        assert.strictEqual(err.code, 'UTXO_SET_TOO_LARGE')
        assert.strictEqual(err.utxoCap, 2)
        assert.match(err.message, /more than 2 UTXOs/)
        return true
      }
    )
    assert.deepStrictEqual(limits, [3])
  })

  it('probes only one row past a full default page before refusing', async () => {
    delete process.env[ENV_NAME]
    const limits = []
    const firstPage = Array.from({ length: UtxoTracker.DEFAULT_MAX_ADDRESS_UTXOS }, (_, i) => utxo(i))
    stubPages([
      { utxos: firstPage, nextCursor: 'one-more' },
      { utxos: [utxo(firstPage.length)] }
    ], limits)

    await assert.rejects(
      () => new UtxoTracker('127.0.0.1', 18420).getUtxosFromAddress(ADDRESS),
      err => err.code === 'UTXO_SET_TOO_LARGE' && err.utxoCap === UtxoTracker.DEFAULT_MAX_ADDRESS_UTXOS
    )
    assert.deepStrictEqual(limits, [10000, 1])
  })
})
