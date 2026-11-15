// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The concurrency gates' occupancy and shed counts reach the metrics scrape.

const assert = require('assert')
const { Registry } = require('../../../src/observability/metrics.js')
const { createConcurrencyGate } = require('../../../src/server/concurrency_gate.js')
const { installGateMetrics } = require('../../../src/server/gate_metrics.js')

function fakeReq () {
  return { ip: '203.0.113.9', path: '/', url: '/', method: 'POST' }
}

function fakeRes () {
  const res = { statusCode: 200, headers: {}, listeners: {} }
  res.setHeader = (k, v) => { res.headers[k] = v; return res }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = () => res
  res.on = (name, fn) => { res.listeners[name] = fn; return res }
  return res
}

// Admit one request into the gate and leave its slot held.
function admit (gate) {
  let admitted = false
  gate(fakeReq(), fakeRes(), () => { admitted = true })
  return admitted
}

describe('installGateMetrics', () => {
  it('publishes limit, in_flight and shed per gate at scrape time', () => {
    const registry = new Registry()
    const request = createConcurrencyGate({ limit: 2 })
    const probe = createConcurrencyGate({ limit: 5 })
    assert.strictEqual(installGateMetrics({ registry }, { request, probe }), true)

    assert.ok(admit(request))
    assert.ok(admit(request))
    assert.ok(!admit(request), 'the third request is shed')

    const text = registry.render()
    assert.match(text, /xchain_encoder_gate_limit\{gate="request"\} 2\b/)
    assert.match(text, /xchain_encoder_gate_in_flight\{gate="request"\} 2\b/)
    assert.match(text, /xchain_encoder_gate_shed_total\{gate="request"\} 1\b/)
    assert.match(text, /xchain_encoder_gate_limit\{gate="probe"\} 5\b/)
    assert.match(text, /xchain_encoder_gate_in_flight\{gate="probe"\} 0\b/)
    assert.match(text, /xchain_encoder_gate_shed_total\{gate="probe"\} 0\b/)
  })

  it('follows the gate as it drains and keeps the shed count monotonic across scrapes', () => {
    const registry = new Registry()
    const gate = createConcurrencyGate({ limit: 1 })
    installGateMetrics({ registry }, { request: gate })
    const res = fakeRes()
    gate(fakeReq(), res, () => {})
    gate(fakeReq(), fakeRes(), () => {})
    registry.render()
    const again = registry.render()
    assert.match(again, /xchain_encoder_gate_shed_total\{gate="request"\} 1\b/)
    assert.match(again, /xchain_encoder_gate_in_flight\{gate="request"\} 1\b/)
    res.listeners.finish()
    assert.match(registry.render(), /xchain_encoder_gate_in_flight\{gate="request"\} 0\b/)
  })

  it('registers nothing without a registry or without a gate that reports stats', () => {
    assert.strictEqual(installGateMetrics(null, { request: createConcurrencyGate({ limit: 1 }) }), false)
    assert.strictEqual(installGateMetrics({ registry: null }, {}), false)
    const registry = new Registry()
    assert.strictEqual(installGateMetrics({ registry }, { request: {} }), false)
    assert.strictEqual(registry.get('xchain_encoder_gate_limit'), null)
  })
})
