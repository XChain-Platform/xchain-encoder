'use strict'

process.env.NETWORK = process.env.NETWORK || 'bitcoin-regtest'
process.env.NODE_URL = process.env.NODE_URL || '127.0.0.1'
process.env.NODE_PORT = process.env.NODE_PORT || '8332'
process.env.NODE_USER = process.env.NODE_USER || 'test'
process.env.NODE_PASSWORD = process.env.NODE_PASSWORD || 'test'

const assert = require('assert')
const XChainEncoder = require('../../../src/XChainEncoder')
const UtxoTracker = require('../../../src/build/utxo_tracker')
const { resolveTrackerProfile, classifyRemoteSync } = require('../../../src/XChainEncoder/trackerless_profile.js')
const { jsonRpcController, encoder: apiEncoder } = require('../../../src/api')
const {
  TXID_A,
  makeUtxo,
  makeEncoder: makeDefaultEncoder,
  getTestAddress
} = require('../../integration/helpers/utxoFactory')

const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const goodSync = { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: true }
const classify = XChainEncoder.classifyTrackerFreshness

function makeEncoder(profile, url = '127.0.0.1', port = '3001') {
  return new XChainEncoder('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', url, port, null, null, undefined, null, profile)
}

async function code(promise) {
  try { await promise } catch (e) { return e.xchainCode || e.message }
  return null
}

function drive(encoder) {
  const steps = require('../../../src/XChainEncoder/build_transaction/input_candidates.js')
  const build = { utxos: null, isReveal: false, p2shHex: null, pubkey: PUBKEY }
  const gen = steps.gatherUtxos.call(encoder, build)
  return (async () => {
    let next = gen.next()
    while (!next.done) {
      let settled
      try { settled = await next.value } catch (err) { next = gen.throw(err); continue }
      next = gen.next(settled)
    }
    return build
  })()
}

function registerProfileTests() {
  it('resolves the profile and rejects unknown values', () => {
    assert.strictEqual(resolveTrackerProfile(undefined), 'default')
    assert.strictEqual(resolveTrackerProfile(' Remote '), 'remote')
    assert.throws(() => resolveTrackerProfile('local'), /UTXO_TRACKER_PROFILE/)
  })

  it('refuses construction without a tracker url or port', () => {
    assert.throws(() => makeEncoder('remote', null, '3001'), (e) => e.xchainCode === 'UTXO_TRACKER_NOT_CONFIGURED')
    assert.throws(() => makeEncoder('remote', '127.0.0.1', ''), (e) => e.xchainCode === 'UTXO_TRACKER_NOT_CONFIGURED')
    assert.doesNotThrow(() => makeEncoder(null, undefined, undefined).trackerProfile)
  })

  it('classifies an absent sync as SYNC_MISSING only in the remote profile', () => {
    assert.strictEqual(classifyRemoteSync('default', undefined, 2), null)
    assert.strictEqual(classifyRemoteSync('remote', undefined, 2).code, 'UTXO_TRACKER_SYNC_MISSING')
    assert.strictEqual(classifyRemoteSync('remote', { synced: true }, 2).code, 'UTXO_TRACKER_SYNC_MISSING')
    assert.strictEqual(classifyRemoteSync('remote', { lag: 0 }, 2).code, 'UTXO_TRACKER_STALE')
    assert.strictEqual(classifyRemoteSync('remote', goodSync, 2), null)
  })

  it('sends the registered lag and heights on a remote STALE for an unasserted synced', () => {
    const refusal = classifyRemoteSync('remote', { tracker_height: 100, node_height: 100, lag: 0 }, 2)
    assert.strictEqual(refusal.code, 'UTXO_TRACKER_STALE')
    assert.deepStrictEqual(refusal.details, { lag: 0, tracker_height: 100, node_height: 100 })
  })
}

function registerStatusTests() {
  const cases = [
    ['unreachable', () => { throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:3001'), { code: 'ECONNREFUSED' }) }, 'UTXO_TRACKER_UNREACHABLE'],
    ['empty status', () => { throw Object.assign(new Error('empty result'), { syncMissing: true }) }, 'UTXO_TRACKER_SYNC_MISSING'],
    ['halted', () => ({ ...goodSync, halted: true, halt_reason: 'deep reorg' }), 'UTXO_TRACKER_HALTED'],
    ['stale', () => ({ ...goodSync, lag: 9, synced: false }), 'UTXO_TRACKER_STALE'],
    ['not ready', () => ({ ...goodSync, mempool_ready: false }), 'UTXO_TRACKER_NOT_READY'],
    ['status without lag', () => ({ synced: true }), 'UTXO_TRACKER_SYNC_MISSING']
  ]
  for (const [name, status, expected] of cases) {
    it(`getUtxos refuses a ${name} tracker with ${expected}`, async () => {
      const enc = makeEncoder('remote')
      enc.utxoTrackerConnector.getSyncStatus = async () => status()
      assert.strictEqual(await code(drive(enc)), expected)
    })
  }
}

function registerUtxoResponseTests() {
  it('refuses a get_utxos response that carries no sync field', async () => {
    const enc = makeEncoder('remote')
    enc.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: [] })
    assert.strictEqual(await code(drive(enc)), 'UTXO_TRACKER_SYNC_MISSING')
  })

  it('wraps a get_utxos transport failure as UNREACHABLE and leaks no host', async () => {
    const enc = makeEncoder('remote')
    enc.utxoTrackerConnector.getUtxosFromAddress = async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:3001'), { code: 'ECONNREFUSED' }) }
    try { await drive(enc); assert.fail('expected refusal') } catch (e) {
      assert.strictEqual(e.xchainCode, 'UTXO_TRACKER_UNREACHABLE')
      assert.ok(!/10\.1\.2\.3/.test(e.message))
    }
  })

  it('keeps the default profile failing open on a missing sync field', async () => {
    const enc = makeEncoder(null)
    enc.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100000, scriptPubKey: '0014' + 'b'.repeat(40), confirmations: 3 }] })
    const build = await drive(enc)
    assert.strictEqual(build.utxos.length, 1)
  })

  it('passes a healthy remote tracker', async () => {
    const enc = makeEncoder('remote')
    enc.utxoTrackerConnector.getUtxosFromAddress = async () => ({ sync: goodSync, utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100000, scriptPubKey: '0014' + 'b'.repeat(40), confirmations: 3 }] })
    assert.strictEqual((await drive(enc)).utxos.length, 1)
  })
}

function registerTrackerTests() {
  it('UtxoTracker.assertTrackerReady types a transport failure in the remote profile', async () => {
    const t = new UtxoTracker('127.0.0.1', 1, 'remote', 2)
    t.getSyncStatus = async () => { throw new Error('socket hang up') }
    assert.strictEqual(await code(t.getUtxosFromAddress('x')), 'UTXO_TRACKER_UNREACHABLE')
  })
}

describe('UTXO_TRACKER_PROFILE=remote fails closed', () => {
  registerProfileTests()
  registerStatusTests()
  registerUtxoResponseTests()
  registerTrackerTests()
})

describe('classifyTrackerFreshness(): the single tracker-freshness verdict', function () {
  it('reports no refusal, and present:false, for a tracker with no freshness surface', function () {
    for (const absent of [undefined, null, 'not an object', 42]) {
      const v = classify(absent, 2)
      assert.strictEqual(v.code, null, 'a pre-freshness tracker must fail open')
      assert.strictEqual(v.present, false)
      assert.strictEqual(v.lag, null)
    }
  })

  it('refuses a halted tracker even at lag 0, and carries the halt reason', function () {
    const v = classify({ tracker_height: 100, node_height: 100, lag: 0, synced: true, halted: true,
      halt_reason: 'rolled back past the recovery window' }, 2)
    assert.strictEqual(v.code, 'UTXO_TRACKER_HALTED')
    assert.strictEqual(v.halted, true)
    assert.strictEqual(v.details.halt_reason, 'rolled back past the recovery window')
    assert.strictEqual(v.details.tracker_height, 100)
  })

  it('names the halt, not the staleness, when a halted tracker is ALSO stale', function () {
    const v = classify({ lag: 99, synced: false, halted: true, mempool_ready: false }, 2)
    assert.strictEqual(v.code, 'UTXO_TRACKER_HALTED')
  })

  it('refuses a tracker that de-asserts synced, whatever the lag', function () {
    const v = classify({ tracker_height: 100, node_height: 100, lag: 0, synced: false }, 2)
    assert.strictEqual(v.code, 'UTXO_TRACKER_STALE')
    assert.strictEqual(v.details.lag, 0)
  })

  it('refuses a lag above the supplied ceiling and names the ceiling it used', function () {
    const v = classify({ lag: 7, synced: true }, 2)
    assert.strictEqual(v.code, 'UTXO_TRACKER_STALE')
    assert.strictEqual(v.overLag, true)
    assert.ok(/exceeds 2-block threshold/.test(v.message), v.message)
  })

  it('takes the ceiling from its argument, not from a baked-in constant', function () {
    assert.strictEqual(classify({ lag: 7, synced: true }, 2).code, 'UTXO_TRACKER_STALE')
    assert.strictEqual(classify({ lag: 7, synced: true }, 10).code, null)
  })
})

describe('classifyTrackerFreshness(): the halt reason is tracker-authored', function () {
  const halted = (reason) => classify({ lag: 0, synced: true, halted: true, halt_reason: reason }, 2)

  it('collapses a halt reason carrying an endpoint in both the message and the details', function () {
    const v = halted('reorg read failed: connect ECONNREFUSED 10.0.0.5:8332')
    assert.strictEqual(v.code, 'UTXO_TRACKER_HALTED')
    assert.ok(v.message.includes('(unrecoverable reorg)'), v.message)
    assert.ok(!/10\.0\.0\.5|8332/.test(v.message), v.message)
    assert.strictEqual(v.details.halt_reason, null)
  })

  it('bounds a long halt reason and keeps an absent one null', function () {
    const v = halted('r'.repeat(1000))
    assert.ok(v.details.halt_reason.length <= 120)
    assert.ok(v.message.length < 200, v.message)
    assert.strictEqual(halted(undefined).details.halt_reason, null)
  })
})

describe('classifyTrackerFreshness(): the single tracker-freshness verdict', function () {
  it('serves at exactly the ceiling (lag == max is not "above")', function () {
    const v = classify({ lag: 2, synced: true }, 2)
    assert.strictEqual(v.code, null)
    assert.strictEqual(v.overLag, false)
  })

  it('refuses an orphaned view (tracker committed above the node) and says so', function () {
    const v = classify({ tracker_height: 1000, node_height: 900, lag: -100, synced: true }, 2)
    assert.strictEqual(v.code, 'UTXO_TRACKER_STALE')
    assert.strictEqual(v.behindNode, true)
    assert.ok(/orphaned/.test(v.message), v.message)
  })

  it('refuses a tracker whose mempool has not reconverged', function () {
    const v = classify({ lag: 0, synced: true, mempool_ready: false }, 2)
    assert.strictEqual(v.code, 'UTXO_TRACKER_NOT_READY')
    assert.strictEqual(v.mempoolReady, false)
  })

  it('fails open on every field it is not explicitly told is bad', function () {
    const v = classify({ tracker_height: 100, node_height: 100, lag: 0, synced: true }, 2)
    assert.strictEqual(v.code, null)
    assert.strictEqual(v.halted, false)
    assert.strictEqual(v.mempoolReady, true)
  })

  it('treats a non-numeric lag as unknown rather than comparing it', function () {
    for (const lag of [undefined, null, '7', NaN]) {
      const v = classify({ lag, synced: true }, 2)
      assert.strictEqual(v.overLag, false, `lag ${String(lag)} must not read as over-lag`)
      assert.strictEqual(v.behindNode, false)
      assert.strictEqual(v.lag, null)
      assert.strictEqual(v.code, null)
    }
  })

  it('separates the tracker\'s positive synced claim from the refusal verdict', function () {
    const omitted = classify({ lag: 0 }, 2)
    assert.strictEqual(omitted.syncedClaimed, false, 'an omitted synced is not an assertion')
    assert.strictEqual(omitted.code, null, 'but it is not an explicit negative either')
  })

  it('does not mutate the sync object it is handed', function () {
    const sync = { tracker_height: 100, node_height: 100, lag: 0, synced: true }
    const before = JSON.stringify(sync)
    classify(sync, 2)
    assert.strictEqual(JSON.stringify(sync), before)
  })
})

const PARITY_CASES = [
  { name: 'healthy', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: true },
    expectCode: null },
  { name: 'lag at the ceiling', sync: { tracker_height: 98, node_height: 100, lag: 2, synced: true, mempool_ready: true },
    expectCode: null },
  { name: 'lag one over the ceiling', sync: { tracker_height: 97, node_height: 100, lag: 3, synced: true, mempool_ready: true },
    expectCode: 'UTXO_TRACKER_STALE' },
  { name: 'tracker de-asserts synced', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: false, mempool_ready: true },
    expectCode: 'UTXO_TRACKER_STALE' },
  { name: 'orphaned view', sync: { tracker_height: 1000, node_height: 900, lag: -100, synced: true, mempool_ready: true },
    expectCode: 'UTXO_TRACKER_STALE' },
  { name: 'halted', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: true, halted: true,
      halt_reason: 'unrecoverable reorg' }, expectCode: 'UTXO_TRACKER_HALTED' },
  { name: 'mempool not reconverged', sync: { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: false },
    expectCode: 'UTXO_TRACKER_NOT_READY' }
]

describe('create_tx and health() reach the same verdict on the same tracker @regression', function () {
  async function createTxVerdict(sync) {
    const enc = makeDefaultEncoder('bitcoin-regtest')
    const address = getTestAddress('bitcoin-regtest')
    enc.utxoTrackerConnector.getUtxosFromAddress = async () => ({
      utxos: [makeUtxo('bitcoin-regtest', TXID_A, 0, 100000000)],
      sync
    })
    try {
      const result = await enc.createTransaction(
        null, address, null, 'test', null, 10000, false, null, address,
        null, null, null, true, 0.00001
      )
      assert.ok(result.psbt)
      return null
    } catch (err) {
      if (!err.operational) throw err
      return err.xchainCode
    }
  }

  async function healthVerdict(sync) {
    const orig = apiEncoder.utxoTrackerConnector.getSyncStatus
    apiEncoder.utxoTrackerConnector.getSyncStatus = async () => sync
    try {
      return await jsonRpcController.health()
    } finally {
      apiEncoder.utxoTrackerConnector.getSyncStatus = orig
    }
  }

  for (const testCase of PARITY_CASES) {
    it(`agrees on: ${testCase.name}`, async function () {
      const code = await createTxVerdict(testCase.sync)
      assert.strictEqual(code, testCase.expectCode,
        `create_tx verdict for "${testCase.name}"`)

      const health = await healthVerdict(testCase.sync)
      assert.strictEqual(health.tracker_synced, testCase.expectCode === null,
        `health() must read ${testCase.expectCode === null ? 'serveable' : 'un-serveable'} ` +
        `for "${testCase.name}", the same way create_tx does`)
    })
  }

  it('reports the halt and the mempool state alongside the verdict', async function () {
    const halted = await healthVerdict({ lag: 0, synced: true, halted: true, halt_reason: 'unrecoverable reorg' })
    assert.strictEqual(halted.tracker_halted, true)
    assert.strictEqual(halted.tracker_synced, false)

    const unready = await healthVerdict({ lag: 0, synced: true, mempool_ready: false })
    assert.strictEqual(unready.tracker_mempool_ready, false)
    assert.strictEqual(unready.tracker_synced, false)
  })
})
