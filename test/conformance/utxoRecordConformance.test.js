// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// CONSUMER half of the shared UTXO-record conformance fixture.
//
// WHAT THIS PINS: the record shape xchain-utxo-tracker actually serves, driven
// through BOTH of this repo's inbound gates - src/UtxoTracker.js's shape gate
// inside getUtxosFromAddress, and src/validator.js validateUtxoEntry. Until
// this file the inbound contract was pinned only by those two hand-written
// restatements plus a prose comment on the tracker side, while every OUTBOUND
// seam (compiledPushSize, the roundtrip fixture, the action manifest) had a
// real cross-repo guard. The one shared artifact that did exist,
// test/integration/helpers/utxoFactory.js, had already drifted to a JS Number
// `value` with no amount/height/coinbase, so the suite would have stayed green
// against a producer that stopped emitting the real record.
//
// The fixture is authored in the sibling xchain-utxo-tracker repo (single
// source of truth, generated from its REAL getUtxosAddress emit path) and
// VENDORED byte-identically into test/fixtures/ here. The vendored copy is
// loaded UNCONDITIONALLY so these assertions always run in single-repo CI; a
// separate byte-identity guard catches drift against the tracker original when
// the sibling checkout is present, and hard-fails under
// XCHAIN_REQUIRE_SIBLINGS=1. Resolving the fixture from the sibling and
// skipping when absent is how the roundtrip suite once reported green having
// executed zero assertions.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const UtxoTracker = require('../../src/UtxoTracker')
const validator = require('../../src/validator')

const VENDORED = path.join(__dirname, '..', 'fixtures', 'utxo-record-conformance.json')
const fixture = JSON.parse(fs.readFileSync(VENDORED, 'utf8'))

const TRACKER_DIR = process.env.XCHAIN_UTXO_TRACKER_DIR ||
  path.join(__dirname, '..', '..', '..', 'xchain-utxo-tracker')
const TRACKER_FIXTURE = path.join(TRACKER_DIR, 'test', 'fixtures', 'utxo-record-conformance.json')

// A deep copy per assertion: validateUtxoEntry mutates its argument in place,
// so sharing one object between tiers would let an earlier tier's coercion
// decide a later tier's result.
const clone = (r) => JSON.parse(JSON.stringify(r))

let originalPost

beforeEach(() => { originalPost = axios.post })
afterEach(() => { axios.post = originalPost })

// Serve the fixture through the real transport seam: one get_sync_status call,
// then one get_utxos page carrying the fixture's own records and sync sibling.
function stubTrackerServing (records, sync) {
  let call = 0
  axios.post = async () => {
    call++
    if (call === 1) {
      return { data: { result: { committed_height: sync.tracker_height, tracker_height: sync.tracker_height, node_height: sync.node_height, lag: sync.lag, synced: sync.synced, mempool_ready: sync.mempool_ready } } }
    }
    return { data: { result: { utxos: records.map(clone), sync } } }
  }
}

describe('utxo-record conformance fixture: the tracker record passes both inbound gates', function () {

  it('the fixture actually carries the shapes this guard needs', function () {
    // Guards the guard: a regenerated fixture that lost a case would otherwise
    // make every tier below pass over an empty or trivial set.
    assert.ok(fixture.servedRecords.length >= 4, 'fixture must carry the served-record set')
    assert.ok(fixture.servedRecords.some((r) => r.height === null && r.confirmations === 0),
      'fixture lost its mempool record')
    assert.ok(fixture.servedRecords.some((r) => r.coinbase === true),
      'fixture lost its coinbase record')
    assert.ok(fixture.servedRecords.some((r) => BigInt(r.value) > BigInt(Number.MAX_SAFE_INTEGER)),
      'fixture lost the above-2^53-1 value that makes value a decimal string')
    assert.ok(fixture.withheldOutpoints.length >= 1, 'fixture lost its withheld-outpoint expectation')
    assert.ok(fixture.sync && typeof fixture.sync === 'object', 'fixture lost its sync sibling')
  })

  it('validateUtxoEntry accepts every record the tracker serves', function () {
    fixture.servedRecords.forEach((r, i) => {
      const entry = clone(r)
      assert.doesNotThrow(() => validator.validateUtxoEntry(entry, i),
        `${r.txid}:${r.vout} is served by the tracker but refused by validateUtxoEntry`)
      assert.strictEqual(entry.txid, r.txid.toLowerCase())
      assert.strictEqual(entry.vout, r.vout)
      assert.strictEqual(entry.confirmations, r.confirmations)
      // No precision loss on the money field, whichever numeric type the
      // validator normalized it to.
      assert.strictEqual(BigInt(entry.value).toString(), r.value,
        `${r.txid}: validateUtxoEntry lost satoshi precision`)
    })
  })

  it('the getUtxosFromAddress shape gate accepts every record the tracker serves', async function () {
    stubTrackerServing(fixture.servedRecords, fixture.sync)
    const tracker = new UtxoTracker('127.0.0.1', 18420)
    const result = await tracker.getUtxosFromAddress(fixture.address)
    assert.strictEqual(result.utxos.length, fixture.servedRecords.length)
    result.utxos.forEach((u, i) => {
      assert.strictEqual(u.txid, fixture.servedRecords[i].txid)
      assert.strictEqual(u.confirmations, fixture.servedRecords[i].confirmations)
    })
  })

  it('the shape gate leaves value as the decimal string it re-exports over get_utxos', async function () {
    // NOT a restatement of the tier above, and the difference is the point.
    // api.js get_utxos returns getUtxosFromAddress's result VERBATIM over the
    // public JSON-RPC surface that xchain-sdk (published to npm), xchain-hub,
    // xchain-e2e-test and xchain-wallet read. validateUtxoEntry mutates `value`
    // in place - to a Number below 2^53-1 and a BigInt above it - so routing
    // the shape gate through it would silently retype that public field, and
    // JSON.stringify THROWS on the BigInt, taking down get_utxos for exactly
    // the DOGE consolidation UTXOs the string type exists for. The two gates
    // are deliberately not the same function; this assertion is what says so.
    stubTrackerServing(fixture.servedRecords, fixture.sync)
    const tracker = new UtxoTracker('127.0.0.1', 18420)
    const result = await tracker.getUtxosFromAddress(fixture.address)
    for (const u of result.utxos) {
      assert.strictEqual(typeof u.value, 'string',
        'the shape gate must not retype value; get_utxos re-exports it verbatim')
    }
    assert.doesNotThrow(() => JSON.stringify({ utxos: result.utxos }),
      'the get_utxos payload must stay JSON-serializable')
  })

  it('the served set withholds every outpoint the tracker refuses to serve', function () {
    const servedKeys = fixture.servedRecords.map((r) => r.txid + ':' + r.vout)
    for (const w of fixture.withheldOutpoints) {
      assert.ok(!servedKeys.includes(w.txid + ':' + w.vout),
        `withheld outpoint ${w.txid}:${w.vout} appeared in the served set (${w.why})`)
    }
  })

  it('the freshness sibling satisfies the encoder fetch gate', async function () {
    // The sync shape is a contract too: getUtxosFromAddress refuses outright on
    // a negative lag, synced:false or mempool_ready:false, so a tracker that
    // renamed a field would fail the fetch, not degrade quietly.
    stubTrackerServing(fixture.servedRecords, fixture.sync)
    const tracker = new UtxoTracker('127.0.0.1', 18420)
    const result = await tracker.getUtxosFromAddress(fixture.address)
    assert.deepStrictEqual(result.sync, fixture.sync)
    for (const field of ['tracker_height', 'node_height', 'lag', 'synced', 'mempool_ready']) {
      assert.ok(field in fixture.sync, `sync sibling lost its ${field} field`)
    }
    assert.ok(fixture.sync.lag >= 0 && fixture.sync.synced === true && fixture.sync.mempool_ready === true,
      'the pinned sync sample must be one the encoder accepts')
  })

  // A conformance test that only proves acceptance has no teeth: these are the
  // producer-side drifts the seam is here to catch, each mutated from a REAL
  // served record so the only difference is the field under test.
  describe('the negative tier: a drifted record must be REFUSED', function () {
    const base = () => clone(fixture.servedRecords.find((r) => r.coinbase === false && r.height !== null))

    const MUTATIONS = [
      { why: 'value emitted as a JS Number (the drift already in utxoFactory)', mutate: (r) => { r.value = Number(r.value) * 1e10 } },
      { why: 'txid truncated to the 16-hex O-key prefix', mutate: (r) => { r.txid = r.txid.slice(0, 16) } },
      { why: 'scriptPubKey given an odd hex length', mutate: (r) => { r.scriptPubKey = r.scriptPubKey.slice(0, -1) } },
      { why: 'confirmations gone negative', mutate: (r) => { r.confirmations = -1 } },
      { why: 'vout emitted as a non-integer', mutate: (r) => { r.vout = 1.5 } }
    ]

    MUTATIONS.forEach(({ why, mutate }) => {
      it(`validateUtxoEntry refuses a record whose ${why}`, function () {
        const entry = base()
        mutate(entry)
        assert.throws(() => validator.validateUtxoEntry(entry, 0),
          (err) => err instanceof TypeError || err instanceof RangeError,
          `validateUtxoEntry accepted a record whose ${why}`)
      })
    })

    // The shape gate is deliberately looser than validateUtxoEntry (it must not
    // retype the public field, see above), so it is pinned against the drifts it
    // is actually the arbiter for rather than against all five.
    const GATE_MUTATIONS = [
      { why: 'txid truncated to the 16-hex O-key prefix', mutate: (r) => { r.txid = r.txid.slice(0, 16) } },
      { why: 'scriptPubKey emptied', mutate: (r) => { r.scriptPubKey = '' } },
      { why: 'confirmations gone negative', mutate: (r) => { r.confirmations = -1 } },
      { why: 'value field dropped entirely', mutate: (r) => { delete r.value } }
    ]

    GATE_MUTATIONS.forEach(({ why, mutate }) => {
      it(`the getUtxosFromAddress shape gate refuses a record whose ${why}`, async function () {
        const entry = base()
        mutate(entry)
        stubTrackerServing([entry], fixture.sync)
        const tracker = new UtxoTracker('127.0.0.1', 18420)
        await assert.rejects(() => tracker.getUtxosFromAddress(fixture.address),
          (err) => err instanceof TypeError,
          `the shape gate accepted a record whose ${why}`)
      })
    })
  })
})

describe('utxo-record conformance fixture: byte-identity to the tracker original', function () {
  before(function () {
    if (!fs.existsSync(TRACKER_FIXTURE)) {
      if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
        throw new Error('xchain-utxo-tracker sibling fixture not found at ' + TRACKER_FIXTURE +
          ' but XCHAIN_REQUIRE_SIBLINGS=1')
      }
      this.skip()
    }
  })

  it('vendored test/fixtures/utxo-record-conformance.json is byte-identical to the tracker original', function () {
    assert.strictEqual(
      fs.readFileSync(VENDORED, 'utf8'),
      fs.readFileSync(TRACKER_FIXTURE, 'utf8'),
      'vendored utxo-record-conformance.json drifted from the tracker original; re-run ' +
      'xchain-utxo-tracker/test/conformance/generateUtxoRecordFixture.js and re-vendor the copy here.'
    )
  })
})
