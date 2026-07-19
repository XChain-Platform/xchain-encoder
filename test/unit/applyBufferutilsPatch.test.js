//  doctrine test-coverage program: unit coverage for
// src/applyBufferutilsPatch.js. The encoder patches bitcoinjs bufferutils so
// 64-bit amount fields round-trip through a BigInt-safe path (values above
// 2^53 would otherwise silently corrupt). This exercises the patched
// read/write and varint helpers the PSBT builder relies on.

const assert = require('assert');
const bufferutils = require('../../src/applyBufferutilsPatch.js');

describe('applyBufferutilsPatch', function () {
    it('exposes the patched bufferutils surface', function () {
        assert.strictEqual(typeof bufferutils.readUInt64LE, 'function');
        assert.strictEqual(typeof bufferutils.writeUInt64LE, 'function');
        assert.ok(bufferutils.varuint, 'varuint must be present');
        assert.strictEqual(typeof bufferutils.varuint.encode, 'function');
        assert.strictEqual(typeof bufferutils.varuint.decode, 'function');
    });

    it('round-trips a small 64-bit LE value', function () {
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, 1234567, 0);
        assert.strictEqual(Number(bufferutils.readUInt64LE(buf, 0)), 1234567);
    });

    it('round-trips a value above 2^53 without precision loss', function () {
        // 21e14 sats is inside the u64 range but past Number.MAX_SAFE_INTEGER,
        // the exact case the BigInt-safe patch exists to protect.
        const big = 9007199254740993n; // 2^53 + 1
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, big, 0);
        assert.strictEqual(BigInt(bufferutils.readUInt64LE(buf, 0)), big);
    });

    it('varuint encode/decode round-trips across size classes', function () {
        for (const n of [0, 252, 253, 65535, 65536, 4294967295]) {
            const enc = bufferutils.varuint.encode(n);
            const dec = bufferutils.varuint.decode(enc, 0);
            assert.strictEqual(Number(dec), n, `varuint failed for ${n}`);
        }
    });
});
