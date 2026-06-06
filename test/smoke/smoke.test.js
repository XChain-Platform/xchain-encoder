/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Smoke Tests — xchain-encoder
 *
 * Fast health-check suite that verifies the encoder's core building blocks
 * are operational. No coin node, no network calls, no external services.
 *
 * Run: npm run smoke-test
 */

const assert = require('assert')
const crypto = require('crypto')

// ---------------------------------------------------------------------------
// S1: Module Loading & Dependency Resolution
// ---------------------------------------------------------------------------
describe('S1: Module Loading', () => {
  it('loads XChainEncoder', () => {
    const mod = require('../../src/XChainEncoder')
    assert.strictEqual(typeof mod, 'function')
  })

  it('loads BlockchainConnector', () => {
    const mod = require('../../src/BlockchainConnector')
    assert.strictEqual(typeof mod, 'function')
  })

  it('loads CryptoNetworks', () => {
    const mod = require('../../src/CryptoNetworks')
    assert.strictEqual(typeof mod.getBitcoinJsNetwork, 'function')
  })

  it('loads TxSizeEstimator', () => {
    const mod = require('../../src/TxSizeEstimator')
    assert.strictEqual(typeof mod.estimateOpReturnOutput, 'function')
    assert.strictEqual(typeof mod.estimateInputSize, 'function')
  })

  it('loads UtxoTracker', () => {
    const mod = require('../../src/UtxoTracker')
    assert.strictEqual(typeof mod, 'function')
  })

  it('loads bitcoinjs-lib with required exports', () => {
    const bitcoin = require('bitcoinjs-lib')
    assert.ok(bitcoin.Psbt)
    assert.ok(bitcoin.payments)
    assert.ok(bitcoin.script)
    assert.ok(bitcoin.networks)
    assert.ok(bitcoin.opcodes)
  })

  it('loads tiny-secp256k1 native module', () => {
    const ecc = require('tiny-secp256k1')
    assert.strictEqual(typeof ecc.isPoint, 'function')
  })
})

// ---------------------------------------------------------------------------
// S2: Encoder Instantiation
// ---------------------------------------------------------------------------
describe('S2: Encoder Instantiation', () => {
  const XChainEncoder = require('../../src/XChainEncoder')

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

// ---------------------------------------------------------------------------
// S3: CryptoNetworks Integrity
// ---------------------------------------------------------------------------
describe('S3: CryptoNetworks Integrity', () => {
  const CryptoNetworks = require('../../src/CryptoNetworks')

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

// ---------------------------------------------------------------------------
// S4: PSBT Object Creation
// ---------------------------------------------------------------------------
describe('S4: PSBT Creation', () => {
  const bitcoin = require('bitcoinjs-lib')
  const CryptoNetworks = require('../../src/CryptoNetworks')

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

// ---------------------------------------------------------------------------
// S5: prepareData — All Encoding Types
// ---------------------------------------------------------------------------
describe('S5: prepareData', () => {
  const bitcoin = require('bitcoinjs-lib')
  const XChainEncoder = require('../../src/XChainEncoder')

  // Use a regtest P2PKH address for P2SH/P2WSH encoding paths
  const PUBKEY_BUF = Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex'
  )
  const network = require('../../src/CryptoNetworks').getBitcoinJsNetwork('bitcoin-regtest')
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

  it('multi-chunk: large data produces multiple OP_RETURN chunks', () => {
    // 200 bytes of data; each OP_RETURN chunk holds 76 usable bytes
    const data = Buffer.alloc(200, 0x44)
    const compiled = bitcoin.script.compile([data])
    const result = encoder.prepareData(compiled, 'OP_RETURN', testAddress)
    assert.ok(result.dataBufferArray.length >= 3)
  })
})

// ---------------------------------------------------------------------------
// S6: Obfuscation Round-Trip
// ---------------------------------------------------------------------------
describe('S6: Obfuscation Round-Trip', () => {
  const XChainEncoder = require('../../src/XChainEncoder')
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

// ---------------------------------------------------------------------------
// S7: TxSizeEstimator Sanity
// ---------------------------------------------------------------------------
describe('S7: TxSizeEstimator', () => {
  const TxSizeEstimator = require('../../src/TxSizeEstimator')
  const bitcoin = require('bitcoinjs-lib')

  it('estimateOpReturnOutput returns positive integer', () => {
    const data = Buffer.from('XCHN test data')
    const size = TxSizeEstimator.estimateOpReturnOutput(data)
    assert.ok(Number.isInteger(size))
    assert.ok(size > 0)
  })

  it('estimateP2shOutput returns positive integer', () => {
    const size = TxSizeEstimator.estimateP2shOutput()
    assert.ok(Number.isInteger(size))
    assert.strictEqual(size, 32)
  })

  it('estimateP2wshOutput returns positive integer', () => {
    const size = TxSizeEstimator.estimateP2wshOutput()
    assert.ok(Number.isInteger(size))
    assert.strictEqual(size, 43)
  })

  it('estimateMultisignOutput returns positive integer', () => {
    const size = TxSizeEstimator.estimateMultisignOutput()
    assert.ok(Number.isInteger(size))
    assert.strictEqual(size, 111)
  })

  it('estimateInputSize: P2WPKH (segwit) is smaller than P2PKH (legacy)', () => {
    const PUBKEY_BUF = Buffer.from(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      'hex'
    )

    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey: PUBKEY_BUF,
      network: bitcoin.networks.regtest
    })
    const segwitInput = {
      hash: 'a'.repeat(64),
      index: 0,
      sequence: 0xffffffff,
      witnessUtxo: { script: p2wpkh.output, value: 100000 }
    }
    const segwitSize = TxSizeEstimator.estimateInputSize(segwitInput)

    const p2pkh = bitcoin.payments.p2pkh({
      pubkey: PUBKEY_BUF,
      network: bitcoin.networks.regtest
    })
    const tx = new bitcoin.Transaction()
    tx.addInput(Buffer.alloc(32, 0x11), 0)
    tx.addOutput(p2pkh.output, 100000)
    const legacyInput = {
      hash: 'a'.repeat(64),
      index: 0,
      sequence: 0xffffffff,
      nonWitnessUtxo: Buffer.from(tx.toHex(), 'hex')
    }
    const legacySize = TxSizeEstimator.estimateInputSize(legacyInput)

    assert.ok(segwitSize < legacySize,
      `Segwit (${segwitSize}) should be smaller than legacy (${legacySize})`)
  })
})

// ---------------------------------------------------------------------------
// S8: Segwit UTXO Detection
// ---------------------------------------------------------------------------
describe('S8: Segwit UTXO Detection', () => {
  const XChainEncoder = require('../../src/XChainEncoder')
  const bitcoin = require('bitcoinjs-lib')

  const PUBKEY_BUF = Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex'
  )

  let encoder
  before(() => {
    encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', '')
  })

  it('P2WPKH scriptPubKey → true', () => {
    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey: PUBKEY_BUF,
      network: bitcoin.networks.regtest
    })
    assert.strictEqual(
      encoder.isSegwitUTXO({ scriptPubKey: p2wpkh.output.toString('hex') }),
      true
    )
  })

  it('P2PKH scriptPubKey → false', () => {
    const p2pkh = bitcoin.payments.p2pkh({
      pubkey: PUBKEY_BUF,
      network: bitcoin.networks.regtest
    })
    assert.strictEqual(
      encoder.isSegwitUTXO({ scriptPubKey: p2pkh.output.toString('hex') }),
      false
    )
  })

  it('P2SH scriptPubKey → false', () => {
    const p2sh = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({
        pubkey: PUBKEY_BUF,
        network: bitcoin.networks.regtest
      }),
      network: bitcoin.networks.regtest
    })
    assert.strictEqual(
      encoder.isSegwitUTXO({ scriptPubKey: p2sh.output.toString('hex') }),
      false
    )
  })

  it('invalid scriptPubKey → false (no throw)', () => {
    assert.strictEqual(
      encoder.isSegwitUTXO({ scriptPubKey: 'zzzz' }),
      false
    )
  })
})

// ---------------------------------------------------------------------------
// S9: dataToPubkey Conversion
// ---------------------------------------------------------------------------
describe('S9: dataToPubkey', () => {
  const XChainEncoder = require('../../src/XChainEncoder')

  let encoder
  before(() => {
    encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8332', 'u', 'p', '', '')
  })

  it('produces 33-byte buffer starting with 0x02', async () => {
    const data = Buffer.alloc(31, 0xab)
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
  })

  it('pads short data to 33 bytes', async () => {
    const data = Buffer.from([0x01, 0x02, 0x03])
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
    // Original data follows the 0x02 prefix
    assert.strictEqual(result[1], 0x01)
    assert.strictEqual(result[2], 0x02)
    assert.strictEqual(result[3], 0x03)
  })

  it('handles exactly 32 bytes of data', async () => {
    const data = Buffer.alloc(32, 0xff)
    const result = await encoder.dataToPubkey(data)
    assert.strictEqual(result.length, 33)
    assert.strictEqual(result[0], 0x02)
  })
})

// ---------------------------------------------------------------------------
// S10: API Server Startup (ping only, no coin node needed)
// ---------------------------------------------------------------------------
describe('S10: API Server Startup', () => {
  const express = require('express')
  const bodyParser = require('body-parser')
  const helmet = require('helmet')
  const cors = require('cors')
  const jsonRouter = require('express-json-rpc-router')

  let server

  afterEach((done) => {
    if (server) {
      server.close(done)
      server = null
    } else {
      done()
    }
  })

  it('Express + JSON-RPC stack starts and responds to ping', (done) => {
    const app = express()
    app.use(helmet())
    app.use(bodyParser.json())
    app.use(cors())

    const jsonRpcController = {
      async ping () { return { status: 'success' } }
    }
    app.use(jsonRouter({ methods: jsonRpcController }))

    // Listen on port 0 to let the OS pick a free port
    server = app.listen(0, () => {
      const port = server.address().port
      const http = require('http')
      const payload = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            assert.deepStrictEqual(parsed.result, { status: 'success' })
            done()
          } catch (err) {
            done(err)
          }
        })
      })
      req.on('error', done)
      req.write(payload)
      req.end()
    })
  })
})
