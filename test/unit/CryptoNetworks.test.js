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
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../../src/CryptoNetworks')

describe('CryptoNetworks', () => {

  describe('.getBitcoinJsNetwork()', () => {

    describe('Bitcoin networks', () => {
      it('returns bitcoin mainnet config with dustThreshold for "bitcoin-mainnet"', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('bitcoin-mainnet')
        assert.strictEqual(result.bech32, bitcoin.networks.bitcoin.bech32)
        assert.strictEqual(result.pubKeyHash, bitcoin.networks.bitcoin.pubKeyHash)
        assert.strictEqual(result.scriptHash, bitcoin.networks.bitcoin.scriptHash)
        assert.strictEqual(result.wif, bitcoin.networks.bitcoin.wif)
        assert.strictEqual(result.dustThreshold, 546)
      })

      it('returns testnet config with dustThreshold for "bitcoin-testnet"', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('bitcoin-testnet')
        assert.strictEqual(result.bech32, bitcoin.networks.testnet.bech32)
        assert.strictEqual(result.pubKeyHash, bitcoin.networks.testnet.pubKeyHash)
        assert.strictEqual(result.dustThreshold, 546)
      })

      it('returns regtest config with dustThreshold for "bitcoin-regtest"', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
        assert.strictEqual(result.bech32, bitcoin.networks.regtest.bech32)
        assert.strictEqual(result.pubKeyHash, bitcoin.networks.regtest.pubKeyHash)
        assert.strictEqual(result.dustThreshold, 546)
      })
    })

    describe('Dogecoin networks', () => {
      const dogeNetworks = ['dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest']

      for (const name of dogeNetworks) {
        it(`returns a valid config for "${name}"`, () => {
          const result = CryptoNetworks.getBitcoinJsNetwork(name)
          assert.ok(result)
          assert.strictEqual(result.messagePrefix, '\x19Dogecoin Signed Message:\n')
          assert.strictEqual(typeof result.bip32.public, 'number')
          assert.strictEqual(typeof result.bip32.private, 'number')
          assert.strictEqual(typeof result.pubKeyHash, 'number')
          assert.strictEqual(typeof result.scriptHash, 'number')
          assert.strictEqual(typeof result.wif, 'number')
          assert.strictEqual(result.dustThreshold, 100000)
        })
      }

      it('dogecoin-mainnet has correct pubKeyHash 0x1e', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('dogecoin-mainnet')
        assert.strictEqual(result.pubKeyHash, 0x1e)
      })

      it('dogecoin-testnet has pubKeyHash 0x71; dogecoin-regtest uses Bitcoin-testnet prefix 0x6f', () => {
        const test = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet')
        const reg = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
        assert.strictEqual(test.pubKeyHash, 0x71)
        // DOGE v1.14.x regtest reuses Bitcoin-testnet prefixes, not Dogecoin-testnet prefixes
        assert.strictEqual(reg.pubKeyHash, 0x6f)
      })
    })

    describe('Litecoin networks', () => {
      const ltcNetworks = ['litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest']

      for (const name of ltcNetworks) {
        it(`returns a valid config for "${name}"`, () => {
          const result = CryptoNetworks.getBitcoinJsNetwork(name)
          assert.ok(result)
          assert.strictEqual(result.messagePrefix, '\x19Litecoin Signed Message:\n')
          assert.strictEqual(typeof result.bech32, 'string')
          // Litecoin's dust relay fee is 10× Bitcoin's → 5460 litoshi floor
          assert.strictEqual(result.dustThreshold, 5460)
        })
      }

      it('litecoin-mainnet has bech32 prefix "ltc"', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('litecoin-mainnet')
        assert.strictEqual(result.bech32, 'ltc')
      })

      it('litecoin-testnet has bech32 prefix "tltc"', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('litecoin-testnet')
        assert.strictEqual(result.bech32, 'tltc')
      })

      it('litecoin-regtest has bech32 prefix "rltc"', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('litecoin-regtest')
        assert.strictEqual(result.bech32, 'rltc')
      })
    })

    describe('Unknown network', () => {
      it('throws TypeError for an unrecognized network name', () => {
        assert.throws(
          () => CryptoNetworks.getBitcoinJsNetwork('unknown-network'),
          { name: 'TypeError' }
        )
      })

      it('throws TypeError for empty string', () => {
        assert.throws(
          () => CryptoNetworks.getBitcoinJsNetwork(''),
          { name: 'TypeError' }
        )
      })
    })
  })

  describe('.getFirstBlock()', () => {
    it('returns 950000 for bitcoin-mainnet', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-mainnet'), 950000)
    })

    it('returns 147500 for bitcoin-testnet', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-testnet'), 147500)
    })

    it('returns 3120000 for litecoin-mainnet', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-mainnet'), 3120000)
    })

    it('returns 4855000 for litecoin-testnet', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-testnet'), 4855000)
    })

    it('returns 6240000 for dogecoin-mainnet', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-mainnet'), 6240000)
    })

    it('returns 67815000 for dogecoin-testnet', () => {
      // DOGE testnet mints min-difficulty blocks ~every 20s, so getFirstBlock
      // anchors near the current tip; the chain climbs above this over time.
      assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-testnet'), 67815000)
    })

    it('returns 0 for bitcoin-regtest', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-regtest'), 0)
    })

    it('returns 0 for litecoin-regtest', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-regtest'), 0)
    })

    it('returns 0 for dogecoin-regtest', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-regtest'), 0)
    })

    it('returns 0 for unknown network', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('eth-mainnet'), 0)
    })
  })
})
