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
          assert.strictEqual(result.dustThreshold, 546)
        })
      }

      it('dogecoin-mainnet has correct pubKeyHash 0x1e', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('dogecoin-mainnet')
        assert.strictEqual(result.pubKeyHash, 0x1e)
      })

      it('dogecoin-testnet and dogecoin-regtest share the same pubKeyHash 0x71', () => {
        const test = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet')
        const reg = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
        assert.strictEqual(test.pubKeyHash, 0x71)
        assert.strictEqual(reg.pubKeyHash, 0x71)
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
      it('returns undefined for an unrecognized network name', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('unknown-network')
        assert.strictEqual(result, undefined)
      })

      it('returns undefined for empty string', () => {
        const result = CryptoNetworks.getBitcoinJsNetwork('')
        assert.strictEqual(result, undefined)
      })
    })
  })

  describe('.getFirstBlock()', () => {
    it('returns 844000 for bitcoin-mainnet', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-mainnet'), 844000)
    })

    it('returns 0 for bitcoin-testnet', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-testnet'), 0)
    })

    it('returns 0 for bitcoin-regtest', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-regtest'), 0)
    })

    it('returns 0 for unknown network', () => {
      assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-mainnet'), 0)
    })
  })
})
