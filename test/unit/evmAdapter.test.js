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
// EvmAdapter / finality-gate pre-work stub tests.
// These lock the finality-gate values and THE L2 TRAP guard, and assert the
// adapter surface is a loud, uniform not-implemented stub (never a silent
// undefined). They do NOT exercise any real EVM tx path (there is none yet).

const assert = require('assert')
const evmFinality = require('../../src/adapters/evmFinality')
const { ChainAdapter, AdapterNotImplementedError } = require('../../src/adapters/ChainAdapter')
const { EvmAdapter } = require('../../src/adapters/EvmAdapter')

describe('EVM finality gate (evmFinality)', () => {

  describe('.finalityGate()', () => {
    it('resolves a known chain case-insensitively', () => {
      const a = evmFinality.finalityGate('eth')
      const b = evmFinality.finalityGate('ETH')
      assert.strictEqual(a, b)
      assert.strictEqual(a.chainId, 1)
    })

    it('throws on an unknown chain rather than returning undefined', () => {
      assert.throws(() => evmFinality.finalityGate('SOLANA'), /No EVM finality gate/)
      assert.throws(() => evmFinality.finalityGate(''), /No EVM finality gate/)
      assert.throws(() => evmFinality.finalityGate(undefined), /No EVM finality gate/)
    })
  })

  describe('L1 Ethereum', () => {
    it('gates on checkpoint finality, not raw depth', () => {
      const g = evmFinality.finalityGate('ETH')
      assert.strictEqual(g.tier, 'L1')
      assert.strictEqual(g.finalityMode, evmFinality.FINALITY_MODES.L1_CHECKPOINT)
      assert.strictEqual(g.epochs, 2)
      assert.strictEqual(g.slotsPerEpoch, 32)
      assert.strictEqual(g.confirmations, 64) // 2 epochs of slots, depth-equivalent floor
      assert.strictEqual(g.nativeDecimals, 18)
    })

    it('L1 block depth IS a sound finality signal', () => {
      assert.strictEqual(evmFinality.isL2BlockDepthSafe('ETH'), true)
      assert.strictEqual(evmFinality.requiresSettlementChainFinality('ETH'), false)
    })
  })

  describe('L2 rollups (THE L2 TRAP, spec §12)', () => {
    const l2s = ['BASE', 'ARBITRUM', 'OPTIMISM']

    l2s.forEach((chain) => {
      it(chain + ' gates on L1 data-posting, never L2 block depth', () => {
        const g = evmFinality.finalityGate(chain)
        assert.strictEqual(g.tier, 'L2')
        assert.strictEqual(g.finalityMode, evmFinality.FINALITY_MODES.L1_DATA_POSTING)
        assert.strictEqual(g.settlementChain, 'ETH')
        assert.strictEqual(g.l2BlockDepthUnsafe, true)
        // No safe L2 depth: the confirmations idiom must NOT be handed an integer
        // that a depth-counting gate could naively use.
        assert.strictEqual(g.confirmations, null)
      })

      it(chain + ' block depth is NOT a sound finality signal', () => {
        assert.strictEqual(evmFinality.isL2BlockDepthSafe(chain), false)
        assert.strictEqual(evmFinality.requiresSettlementChainFinality(chain), true)
      })
    })
  })

  it('recommends Base as the primary L2 target (spec §11)', () => {
    assert.strictEqual(evmFinality.PRIMARY_L2_TARGET, 'BASE')
    // The recommended target must itself be a defined L2 gate.
    const g = evmFinality.finalityGate(evmFinality.PRIMARY_L2_TARGET)
    assert.strictEqual(g.tier, 'L2')
  })

  it('no EVM chain is armed into a consensus pin (pre-work only)', () => {
    for (const key of Object.keys(evmFinality.EVM_FINALITY)) {
      assert.strictEqual(evmFinality.EVM_FINALITY[key].armed, false,
        key + ' must stay unarmed until a coordinated coin-file + pin bump')
    }
  })
})

describe('ChainAdapter base', () => {
  it('every surface method throws AdapterNotImplementedError with the method name', () => {
    const base = new ChainAdapter('utxo')
    const methods = [
      ['buildUnsignedTx', []],
      ['estimateFee', [{}]],
      ['resolveSource', [{}]],
      ['extractPayload', [{}]],
      ['deriveObfuscationKey', [{}]],
      ['pollBlock', [0]],
      ['detectReorg', [0, 'h']],
    ]
    for (const [name, args] of methods) {
      try {
        base[name](...args)
        assert.fail(name + ' should have thrown')
      } catch (e) {
        assert.ok(e instanceof AdapterNotImplementedError, name + ' wrong error type')
        assert.strictEqual(e.notImplemented, true)
        assert.strictEqual(e.method, name)
        assert.strictEqual(e.family, 'utxo')
      }
    }
  })
})

describe('EvmAdapter (pre-work stub)', () => {
  it('defaults to the spec primary L2 target', () => {
    const a = new EvmAdapter()
    assert.strictEqual(a.chain, 'BASE')
    assert.strictEqual(a.family, 'evm')
  })

  it('normalizes the chain key and validates it at construction', () => {
    const a = new EvmAdapter('eth')
    assert.strictEqual(a.chain, 'ETH')
    assert.throws(() => new EvmAdapter('bogus'), /No EVM finality gate/)
  })

  it('exposes the finality gate for its chain (the load-bearing pre-work)', () => {
    const a = new EvmAdapter('ETH')
    const g = a.getFinalityGate()
    assert.strictEqual(g.finalityMode, evmFinality.FINALITY_MODES.L1_CHECKPOINT)
  })

  it('surfaces THE L2 TRAP guard per chain', () => {
    assert.strictEqual(new EvmAdapter('ETH').isL2BlockDepthSafe(), true)
    assert.strictEqual(new EvmAdapter('BASE').isL2BlockDepthSafe(), false)
  })

  it('leaves every tx-building surface as a loud not-implemented stub', () => {
    const a = new EvmAdapter('BASE')
    const stubbed = ['buildUnsignedTx', 'estimateFee', 'resolveSource',
      'extractPayload', 'deriveObfuscationKey', 'pollBlock', 'detectReorg']
    for (const name of stubbed) {
      assert.throws(() => a[name]({}), (e) => {
        return e instanceof AdapterNotImplementedError &&
          e.family === 'evm' && e.method === name
      }, name + ' should be an EVM not-implemented stub')
    }
  })
})
