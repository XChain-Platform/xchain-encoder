'use strict'

process.env.NETWORK = process.env.NETWORK || 'bitcoin-regtest'

const assert = require('assert')
const XChainEncoder = require('../../../../src/XChainEncoder')
const UtxoTracker = require('../../../../src/build/utxo_tracker')
const { resolveTrackerProfile, classifyRemoteSync } = require('../../../../src/XChainEncoder/trackerless_profile.js')

const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const goodSync = { tracker_height: 100, node_height: 100, lag: 0, synced: true, mempool_ready: true }

function makeEncoder(profile, url = '127.0.0.1', port = '3001') {
  return new XChainEncoder('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', url, port, null, null, undefined, null, profile)
}

async function code(promise) {
  try { await promise } catch (e) { return e.xchainCode || e.message }
  return null
}

function drive(encoder) {
  const steps = require('../../../../src/XChainEncoder/build_transaction/input_candidates.js')
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
