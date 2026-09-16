/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Smoke Tests: xchain-encoder
 *
 * Fast health-check suite that verifies the encoder's core building blocks
 * are operational. No coin node, no network calls, no external services.
 *
 * Run: npm run smoke-test
 */

const assert = require('assert')
const crypto = require('crypto')
const BlockchainConnector = require('../../src/build/blockchain_connector');
const UtxoTracker = require('../../src/build/utxo_tracker');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const XChainEncoder = require('../../src/XChainEncoder');
const CryptoNetworks = require('../../src/build/crypto_networks');
const TxSizeEstimator = require('../../src/build/tx_size_estimator');

describe('S1: Module Loading', () => {
  it('loads XChainEncoder', () => {
    assert.strictEqual(typeof XChainEncoder, 'function')
  })

  it('loads BlockchainConnector', () => {
    assert.strictEqual(typeof BlockchainConnector, 'function')
  })

  it('loads CryptoNetworks', () => {
    assert.strictEqual(typeof CryptoNetworks.getBitcoinJsNetwork, 'function')
  })

  it('loads TxSizeEstimator', () => {
    assert.strictEqual(typeof TxSizeEstimator.estimateOpReturnOutput, 'function')
    assert.strictEqual(typeof TxSizeEstimator.estimateInputSize, 'function')
  })

  it('loads UtxoTracker', () => {
    assert.strictEqual(typeof UtxoTracker, 'function')
  })

  it('loads bitcoinjs-lib with required exports', () => {
    assert.ok(bitcoin.Psbt)
    assert.ok(bitcoin.payments)
    assert.ok(bitcoin.script)
    assert.ok(bitcoin.networks)
    assert.ok(bitcoin.opcodes)
  })

  it('loads tiny-secp256k1 native module', () => {
    assert.strictEqual(typeof ecc.isPoint, 'function')
  })
})

describe('S2: Encoder Instantiation', () => {

  const networks = ['bitcoin-regtest', 'dogecoin-regtest', 'litecoin-regtest']

  for (const net of networks) {
    it(`constructs without error for "${net}"`, () => {
      const encoder = new XChainEncoder(net, '127.0.0.1', '8332', 'u', 'p', '', '')
      assert.ok(encoder)
      assert.ok(encoder.network)
      assert.ok(encoder.connector)
      assert.strictEqual(typeof encoder.dustAmount, 'number')
      assert.ok(encoder.dustAmount > 0)
    })
  }

  it('applies maxFeeRateKb cap', () => {
    const encoder = new XChainEncoder(
      'bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', '', 100000
    )
    assert.ok(encoder.maxFeePerBytes > 0)
  })

  it('maxFeePerBytes is null when no cap provided', () => {
    const encoder = new XChainEncoder(
      'bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', ''
    )
    assert.strictEqual(encoder.maxFeePerBytes, null)
  })
})

describe('S3: CryptoNetworks Integrity', () => {

  const allNetworks = [
    'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
    'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
    'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest'
  ]

  for (const name of allNetworks) {
    it(`resolves "${name}" with required fields`, () => {
      const net = CryptoNetworks.getBitcoinJsNetwork(name)
      assert.ok(net, `${name} returned falsy`)
      assert.strictEqual(typeof net.pubKeyHash, 'number')
      assert.strictEqual(typeof net.scriptHash, 'number')
      assert.strictEqual(typeof net.wif, 'number')
      assert.strictEqual(typeof net.dustThreshold, 'number')
      assert.ok(net.dustThreshold > 0)
    })
  }

  it('mainnet and regtest have distinct pubKeyHash for bitcoin', () => {
    const mainnet = CryptoNetworks.getBitcoinJsNetwork('bitcoin-mainnet')
    const regtest = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
    assert.notStrictEqual(mainnet.pubKeyHash, regtest.pubKeyHash)
  })

  it('mainnet and testnet have distinct pubKeyHash for dogecoin', () => {
    const mainnet = CryptoNetworks.getBitcoinJsNetwork('dogecoin-mainnet')
    const testnet = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet')
    assert.notStrictEqual(mainnet.pubKeyHash, testnet.pubKeyHash)
  })

  it('throws TypeError for unknown network', () => {
    assert.throws(
      () => CryptoNetworks.getBitcoinJsNetwork('invalid-network'),
      { name: 'TypeError' }
    )
  })
})

describe('S4: PSBT Creation', () => {

  it('creates a PSBT for bitcoin-regtest', () => {
    const network = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
    const psbt = new bitcoin.Psbt({ network })
    assert.ok(psbt)
  })

  it('adds an OP_RETURN output and serializes to hex', () => {
    const network = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
    const psbt = new bitcoin.Psbt({ network })
    const data = Buffer.from('XCHN smoke test')
    const embed = bitcoin.payments.embed({ data: [data] })
    psbt.addOutput({ script: embed.output, value: 0 })
    const hex = psbt.toHex()
    assert.strictEqual(typeof hex, 'string')
    assert.ok(hex.length > 0)
  })

  it('adds a P2PKH output', () => {
    const network = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
    const pubkey = Buffer.from(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      'hex'
    )
    const addr = bitcoin.payments.p2pkh({ pubkey, network }).address
    const psbt = new bitcoin.Psbt({ network })
    psbt.addOutput({ address: addr, value: 1000 })
    const hex = psbt.toHex()
    assert.ok(hex.length > 0)
  })
})

describe('S5: prepareData', () => {

  // Use a regtest P2PKH address for P2SH/P2WSH encoding paths
  const PUBKEY_BUF = Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex'
  )
  const network = require('../../src/build/crypto_networks').getBitcoinJsNetwork('bitcoin-regtest')
  const testAddress = bitcoin.payments.p2pkh({ pubkey: PUBKEY_BUF, network }).address

  let encoder
  beforeEach(() => {
    encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', '')
  })

  it('OP_RETURN: short data prefixed with XCHN magic word', () => {
    const data = Buffer.from('SEND|0|JDOG|1|addr')
    const compiled = bitcoin.script.compile([data])
    const result = encoder.prepareData(compiled, 'OP_RETURN', testAddress)
    assert.strictEqual(result.encoding, 'OP_RETURN')
    assert.ok(result.dataBufferArray.length >= 1)
    // First 4 bytes of each chunk must be XCHN
    const magic = result.dataBufferArray[0].slice(0, 4).toString('utf8')
    assert.strictEqual(magic, 'XCHN')
  })

  it('OP_RETURN: auto-selects when data fits in 80 bytes', () => {
    const data = Buffer.from('SEND|0|T|1|a')
    const compiled = bitcoin.script.compile([data])
    const result = encoder.prepareData(compiled, null, testAddress)
    assert.strictEqual(result.encoding, 'OP_RETURN')
  })

  it('P2SH: auto-selects when data exceeds OP_RETURN limit', () => {
    const data = Buffer.alloc(100, 0x41) // 100 bytes > 76 usable
    const compiled = bitcoin.script.compile([data])
    const result = encoder.prepareData(compiled, null, testAddress)
    assert.strictEqual(result.encoding, 'P2SH')
  })

  it('P2SH: produces script buffers', () => {
    const data = Buffer.alloc(200, 0x42)
    const compiled = bitcoin.script.compile([data])
    const result = encoder.prepareData(compiled, 'P2SH', testAddress)
    assert.strictEqual(result.encoding, 'P2SH')
    assert.ok(result.dataBufferArray.length >= 1)
    assert.ok(Buffer.isBuffer(result.dataBufferArray[0]))
  })
})

describe('S5: prepareData', () => {

  // Use a regtest P2PKH address for P2SH/P2WSH encoding paths
  const PUBKEY_BUF = Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex'
  )
  const network = require('../../src/build/crypto_networks').getBitcoinJsNetwork('bitcoin-regtest')
  const testAddress = bitcoin.payments.p2pkh({ pubkey: PUBKEY_BUF, network }).address

  let encoder
  beforeEach(() => {
    encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', '')
  })

  it('P2WSH: produces script buffers', () => {
    const data = Buffer.alloc(5000, 0x43)
    const compiled = bitcoin.script.compile([data])
    const result = encoder.prepareData(compiled, 'P2WSH', testAddress)
    assert.strictEqual(result.encoding, 'P2WSH')
    assert.ok(result.dataBufferArray.length >= 1)
  })

  it('MULTISIGN: chunks prefixed with XCHN magic word', () => {
    const data = Buffer.from('SEND|0|JDOG|1|addr')
    const compiled = bitcoin.script.compile([data])
    const result = encoder.prepareData(compiled, 'MULTISIGN', testAddress)
    assert.strictEqual(result.encoding, 'MULTISIGN')
    assert.ok(result.dataBufferArray.length >= 1)
    const magic = result.dataBufferArray[0].slice(0, 4).toString('utf8')
    assert.strictEqual(magic, 'XCHN')
  })

  it('oversized OP_RETURN is rejected (single output per transaction)', () => {
    // A transaction may carry at most one OP_RETURN output; Bitcoin Core
    // rejects multi-OP_RETURN transactions as non-standard. A payload larger
    // than one 76-byte chunk must throw rather than split into outputs.
    const data = Buffer.alloc(200, 0x44)
    const compiled = bitcoin.script.compile([data])
    assert.throws(() => encoder.prepareData(compiled, 'OP_RETURN', testAddress), RangeError)
  })
})

describe('S6: Obfuscation Round-Trip', () => {
  const TXID = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

  let encoder
  beforeEach(() => {
    encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', '')
  })

  it('output length matches input length (CTR mode)', async () => {
    const data = Buffer.from('XCHN smoke test payload')
    const encrypted = await encoder.obfuscate(data, TXID)
    assert.strictEqual(encrypted.length, data.length)
  })

  it('encrypts (output differs from input)', async () => {
    const data = Buffer.from('XCHN smoke test payload')
    const encrypted = await encoder.obfuscate(data, TXID)
    assert.notDeepStrictEqual(encrypted, data)
  })

  it('round-trips: double-obfuscate recovers original', async () => {
    const data = Buffer.from('SEND|0|TOKEN|100|addr')
    const encrypted = await encoder.obfuscate(data, TXID)
    const decrypted = await encoder.obfuscate(encrypted, TXID)
    assert.deepStrictEqual(decrypted, data)
  })

  it('different keys produce different ciphertext', async () => {
    const data = Buffer.from('key test')
    const key2 = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    const r1 = await encoder.obfuscate(data, TXID)
    const r2 = await encoder.obfuscate(data, key2)
    assert.notDeepStrictEqual(r1, r2)
  })

  it('handles empty input without error', async () => {
    const data = Buffer.alloc(0)
    const encrypted = await encoder.obfuscate(data, TXID)
    assert.strictEqual(encrypted.length, 0)
  })
})
