const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')

const MAGIC_WORD = 'XCHN'
const MAGIC_LEN = 4
const OP_RETURN_SIZE = 80
const P2SH_SIZE = 520
const PW2SH_SIZE = 3615
const MULTISIGN_SIZE = 69

// A valid regtest P2PKH address for P2SH/P2WSH redeem script tests
const REGTEST_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'),
  network: bitcoin.networks.regtest
}).address

function makeEncoder () {
  return new XChainEncoder(
    'bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
}

describe('XChainEncoder.prepareData()', () => {
  let encoder

  beforeEach(() => {
    encoder = makeEncoder()
  })

  // ── Auto-selection ───────────────────────────────────────────────

  describe('auto-selection (encoding = null/undefined)', () => {
    it('selects OP_RETURN when data fits within 76 bytes (80 - 4 magic)', () => {
      const data = Buffer.alloc(76) // exactly at limit
      const result = encoder.prepareData(data, undefined, REGTEST_ADDRESS)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('selects P2SH when data exceeds 76 bytes', () => {
      const data = Buffer.alloc(77)
      const result = encoder.prepareData(data, undefined, REGTEST_ADDRESS)
      assert.strictEqual(result.encoding, 'P2SH')
    })

    it('selects OP_RETURN for very small data (1 byte)', () => {
      const data = Buffer.from([0x42])
      const result = encoder.prepareData(data, undefined, REGTEST_ADDRESS)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('selects OP_RETURN for empty data', () => {
      const data = Buffer.alloc(0)
      const result = encoder.prepareData(data, undefined, REGTEST_ADDRESS)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  // ── OP_RETURN ────────────────────────────────────────────────────

  describe('OP_RETURN encoding', () => {
    it('produces a single chunk for data that fits', () => {
      const data = Buffer.from('Hello XChain')
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      assert.strictEqual(result.dataBufferArray.length, 1)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })

    it('prepends XCHN magic word to each chunk', () => {
      const data = Buffer.from('test')
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      const chunk = result.dataBufferArray[0]
      assert.strictEqual(chunk.subarray(0, 4).toString('utf8'), MAGIC_WORD)
    })

    it('data follows the magic word', () => {
      const data = Buffer.from('payload')
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      const chunk = result.dataBufferArray[0]
      assert.deepStrictEqual(chunk.subarray(MAGIC_LEN), data)
    })

    it('chunk size does not exceed OP_RETURN_SIZE (80 bytes)', () => {
      const data = Buffer.alloc(76) // max per chunk = 80 - 4 = 76
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      for (const chunk of result.dataBufferArray) {
        assert.ok(chunk.length <= OP_RETURN_SIZE,
          `chunk length ${chunk.length} exceeds ${OP_RETURN_SIZE}`)
      }
    })

    it('produces multiple chunks for data exceeding one chunk', () => {
      // Each chunk holds 76 bytes of data; 153 bytes = 3 chunks
      const data = Buffer.alloc(153, 0xAA)
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      assert.strictEqual(result.dataBufferArray.length, 3)
    })

    it('preserves all data across chunks (no loss, no overlap)', () => {
      const data = Buffer.alloc(200, 0)
      for (let i = 0; i < data.length; i++) data[i] = i % 256
      const result = encoder.prepareData(data, 'OP_RETURN', null)

      const reassembled = Buffer.concat(
        result.dataBufferArray.map(c => c.subarray(MAGIC_LEN))
      )
      assert.deepStrictEqual(reassembled, data)
    })

    it('pubKey is not used (null pubKey works)', () => {
      const data = Buffer.from('test')
      const result = encoder.prepareData(data, 'OP_RETURN', null)
      assert.ok(result)
      assert.strictEqual(result.encoding, 'OP_RETURN')
    })
  })

  // ── P2SH ─────────────────────────────────────────────────────────

  describe('P2SH encoding', () => {
    const chunkDataSize = P2SH_SIZE - 44 // 476

    it('produces compiled redeem scripts with correct opcodes', () => {
      const data = Buffer.alloc(100, 0xBB)
      const result = encoder.prepareData(data, 'P2SH', REGTEST_ADDRESS)
      const script = result.dataBufferArray[0]
      const decompiled = bitcoin.script.decompile(script)

      // data, OP_DROP, OP_DUP, OP_HASH160, pubkeyHash, OP_EQUALVERIFY, OP_CHECKSIG
      assert.ok(Buffer.isBuffer(decompiled[0]), 'first element is data buffer')
      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)
      assert.strictEqual(decompiled[2], bitcoin.opcodes.OP_DUP)
      assert.strictEqual(decompiled[3], bitcoin.opcodes.OP_HASH160)
      assert.ok(Buffer.isBuffer(decompiled[4]), 'fifth element is pubkey hash')
      assert.strictEqual(decompiled[4].length, 20)
      assert.strictEqual(decompiled[5], bitcoin.opcodes.OP_EQUALVERIFY)
      assert.strictEqual(decompiled[6], bitcoin.opcodes.OP_CHECKSIG)
    })

    it('splits data into chunks of 476 bytes max', () => {
      const data = Buffer.alloc(chunkDataSize + 1, 0xCC) // needs 2 chunks
      const result = encoder.prepareData(data, 'P2SH', REGTEST_ADDRESS)
      assert.strictEqual(result.dataBufferArray.length, 2)
    })

    it('single chunk for data exactly at boundary', () => {
      const data = Buffer.alloc(chunkDataSize, 0xDD)
      const result = encoder.prepareData(data, 'P2SH', REGTEST_ADDRESS)
      assert.strictEqual(result.dataBufferArray.length, 1)
    })

    it('preserves all data across chunks', () => {
      const data = Buffer.alloc(1000, 0)
      for (let i = 0; i < data.length; i++) data[i] = i % 256
      const result = encoder.prepareData(data, 'P2SH', REGTEST_ADDRESS)

      const reassembled = Buffer.concat(
        result.dataBufferArray.map(script => {
          const decompiled = bitcoin.script.decompile(script)
          return decompiled[0] // first element is the data chunk
        })
      )
      assert.deepStrictEqual(reassembled, data)
    })
  })

  // ── P2WSH ────────────────────────────────────────────────────────

  describe('P2WSH encoding', () => {
    const chunkDataSize = PW2SH_SIZE - 44 // 3571

    it('produces compiled redeem scripts same structure as P2SH', () => {
      const data = Buffer.alloc(100, 0xEE)
      const result = encoder.prepareData(data, 'P2WSH', REGTEST_ADDRESS)
      const script = result.dataBufferArray[0]
      const decompiled = bitcoin.script.decompile(script)

      assert.strictEqual(decompiled[1], bitcoin.opcodes.OP_DROP)
      assert.strictEqual(decompiled[6], bitcoin.opcodes.OP_CHECKSIG)
    })

    it('uses the P2WSH chunk size (3571) — larger than P2SH (476)', () => {
      // Data that fits in one P2WSH chunk but would need many P2SH chunks
      const data = Buffer.alloc(3000, 0xFF)
      const result = encoder.prepareData(data, 'P2WSH', REGTEST_ADDRESS)
      assert.strictEqual(result.dataBufferArray.length, 1)
    })

    it('splits into multiple chunks when data exceeds 3571 bytes', () => {
      const data = Buffer.alloc(chunkDataSize + 1, 0xAA)
      const result = encoder.prepareData(data, 'P2WSH', REGTEST_ADDRESS)
      assert.strictEqual(result.dataBufferArray.length, 2)
    })
  })

  // ── MULTISIGN ────────────────────────────────────────────────────

  describe('MULTISIGN encoding', () => {
    // MULTISIGN_SIZE(69) - MAGIC_LEN(4) - 1 - 1 - 1 - 1 - 1 = 60
    const chunkDataSize = MULTISIGN_SIZE - MAGIC_LEN - 1 - 1 - 1 - 1 - 1 // 60

    it('prepends XCHN magic word to each chunk', () => {
      const data = Buffer.from('multisig test')
      const result = encoder.prepareData(data, 'MULTISIGN', null)
      const chunk = result.dataBufferArray[0]
      assert.strictEqual(chunk.subarray(0, 4).toString('utf8'), MAGIC_WORD)
    })

    it('single chunk for data within limit', () => {
      const data = Buffer.alloc(chunkDataSize, 0x11)
      const result = encoder.prepareData(data, 'MULTISIGN', null)
      assert.strictEqual(result.dataBufferArray.length, 1)
    })

    it('multiple chunks for data exceeding limit', () => {
      const data = Buffer.alloc(chunkDataSize + 1, 0x22)
      const result = encoder.prepareData(data, 'MULTISIGN', null)
      assert.strictEqual(result.dataBufferArray.length, 2)
    })

    it('preserves all data across chunks', () => {
      const data = Buffer.alloc(200, 0)
      for (let i = 0; i < data.length; i++) data[i] = i % 256
      const result = encoder.prepareData(data, 'MULTISIGN', null)

      const reassembled = Buffer.concat(
        result.dataBufferArray.map(c => c.subarray(MAGIC_LEN))
      )
      assert.deepStrictEqual(reassembled, data)
    })

    it('pubKey is not used (null pubKey works)', () => {
      const data = Buffer.from('test')
      const result = encoder.prepareData(data, 'MULTISIGN', null)
      assert.ok(result)
    })
  })

  // ── Invalid encoding ─────────────────────────────────────────────

  describe('invalid encoding', () => {
    it('throws TypeError for unrecognized encoding string', () => {
      const data = Buffer.from('test')
      assert.throws(
        () => encoder.prepareData(data, 'INVALID', null),
        { name: 'TypeError' }
      )
    })
  })
})
