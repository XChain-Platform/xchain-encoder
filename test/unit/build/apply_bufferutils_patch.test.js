// Unit coverage for src/build/apply_bufferutils_patch.js. The encoder patches
// bitcoinjs bufferutils so 64-bit amount fields round-trip through a
// BigInt-safe path (values above 2^53 would otherwise silently corrupt).
// This exercises the patched read/write and varint helpers the PSBT builder
// relies on.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bufferutils = require('../../../src/build/apply_bufferutils_patch.js');

function findSdkRoot(repoRoot) {
    let cursor = path.dirname(repoRoot);
    while (cursor !== path.dirname(cursor)) {
        const candidate = path.join(cursor, 'xchain-sdk');
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
        cursor = path.dirname(cursor);
    }
    return null;
}

function patchModuleSources(entry) {
    const pending = [entry];
    const sources = new Map();
    while (pending.length > 0) {
        const file = pending.pop();
        if (sources.has(file)) continue;
        const source = fs.readFileSync(file, 'utf8');
        sources.set(file, source);
        for (const match of source.matchAll(/require\('([^']+)'\)/g)) {
            if (!match[1].startsWith('.')) continue;
            pending.push(require.resolve(path.resolve(path.dirname(file), match[1])));
        }
    }
    return sources;
}

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

describe('applyBufferutilsPatch', function () {

    // The write-side contract this copy ships (and that the header documents):
    // readers narrow to a Number at or below 2^53-1 and return a BigInt above
    // it; the module-level helpers accept the full u64 range. The decoder and
    // utxo-tracker copies deliberately differ (always-BigInt reader, stock
    // 2^53-1 helper ceiling), so this pins THIS copy rather than a shared one.
    it('narrows a representable value to Number and keeps a BigInt only above 2^53-1', function () {
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, 9007199254740991n, 0);          // 2^53-1
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 9007199254740991);
        assert.strictEqual(typeof new bufferutils.BufferReader(buf).readUInt64(), 'number');
        bufferutils.writeUInt64LE(buf, 9007199254740992n, 0);          // 2^53
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 9007199254740992n);
        assert.strictEqual(typeof new bufferutils.BufferReader(buf).readUInt64(), 'bigint');
    });

    it('module-level helpers accept the full u64 range and reject one past it', function () {
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, 0xffffffffffffffffn, 0);
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 0xffffffffffffffffn);
        assert.throws(() => bufferutils.writeUInt64LE(buf, 0x10000000000000000n, 0), /value out of range/);
    });

    // The header promises stock verifuint's error strings, and a caller that
    // branches on them only keeps working if EVERY rejected value produces the
    // one stock verifuint produces. Testing fractional before the range checks
    // broke that for -0.5, and converting to BigInt before them let +/-Infinity
    // out as a native BigInt RangeError that is neither stock string.
    it('rejects every invalid value with the stock verifuint string', function () {
        const buf = Buffer.alloc(8);
        const cases = [
            ['5',        /cannot write a non-number as a number/],
            [-0.5,       /specified a negative value for writing an unsigned value/],
            [-1,         /specified a negative value for writing an unsigned value/],
            [-1n,        /specified a negative value for writing an unsigned value/],
            [-Infinity,  /specified a negative value for writing an unsigned value/],
            [Infinity,   /value out of range/],
            [2 ** 53,    /value out of range/],
            [2 ** 60,    /value out of range/],
            [1e16 + 1,   /value out of range/],
            [1e30,       /value out of range/],
            [0.5,        /value has a fractional component/],
            [NaN,        /value has a fractional component/]
        ];
        for (const [value, expected] of cases) {
            assert.throws(() => bufferutils.writeUInt64LE(buf, value, 0), expected,
                'wrong error string for ' + String(value));
            // The native BigInt conversion error is the specific escape hatch
            // the guard order closes, so name it rather than only the shape.
            assert.throws(() => bufferutils.writeUInt64LE(buf, value, 0),
                (err) => !/cannot be converted to a BigInt/.test(err.message),
                'a native BigInt conversion error escaped for ' + String(value));
        }
    });
});

describe('applyBufferutilsPatch', function () {
    // A Number past 2^53-1 has already lost its exact value, so every writer refuses it
    // as stock verifuint does, while the same amount as a BigInt still serializes.
    it('caps a Number at 2^53-1 on every writer while a BigInt passes', function () {
        const buf = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buf, 9007199254740991, 0);
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 9007199254740991);
        bufferutils.writeUInt64LE(buf, 9007199254740992n, 0);
        assert.strictEqual(bufferutils.readUInt64LE(buf, 0), 9007199254740992n);
        assert.throws(() => new bufferutils.BufferWriter(Buffer.alloc(8)).writeUInt64(2 ** 53), /value out of range/);
    });

    it('refuses a PSBT witnessUtxo Number value past 2^53-1 and serializes its BigInt form', function () {
        const { Psbt } = require('bitcoinjs-lib');
        const input = (value) => ({ hash: Buffer.alloc(32, 1), index: 0,
            witnessUtxo: { script: Buffer.from('0014' + '11'.repeat(20), 'hex'), value } });
        assert.throws(() => { const psbt = new Psbt(); psbt.addInput(input(2 ** 53)); psbt.toBuffer(); },
            /value out of range/);
        const psbt = new Psbt();
        psbt.addInput(input(9007199254740992n));
        assert.ok(psbt.toBuffer().length > 0);
    });
});

describe('applyBufferutilsPatch', function () {

    // Fee-accounting wrapper: bitcoinjs-lib's stock cache getter tests __FEE /
    // __FEE_RATE for truthiness, so a primed 0 (zero fee, or any fee under
    // 1 sat/vbyte) must be answered by the wrapper itself rather than by
    // re-running stock, which would re-throw the BigInt-mixing TypeError.
    describe('BigInt fee accounting (getFee / getFeeRate / extractTransaction)', function () {
        const { Psbt } = require('bitcoinjs-lib');
        function finalizedPsbt(inputValue, outputValue) {
            const psbt = new Psbt();
            psbt.addInput({
                hash: Buffer.alloc(32, 1), index: 0,
                witnessUtxo: { script: Buffer.from('0014' + '11'.repeat(20), 'hex'), value: inputValue }
            });
            psbt.addOutput({ script: Buffer.from('0014' + '22'.repeat(20), 'hex'), value: outputValue });
            // An empty witness stack is enough for isFinalized; no signing needed.
            psbt.updateInput(0, { finalScriptWitness: Buffer.from([0]) });
            return psbt;
        }

        it('returns 0 for a zero-fee PSBT with BigInt values instead of re-throwing', function () {
            const psbt = finalizedPsbt(1000n, 1000n);
            assert.strictEqual(psbt.getFee(), 0);
            assert.strictEqual(psbt.getFeeRate(), 0);
            assert.ok(psbt.extractTransaction());
        });

        it('returns a 0 fee rate for a sub-1-sat/vbyte fee instead of re-throwing', function () {
            const psbt = finalizedPsbt(100000n, 99990n);
            assert.strictEqual(psbt.getFee(), 10);
            assert.strictEqual(psbt.getFeeRate(), 0);
            assert.ok(psbt.extractTransaction());
        });

        it('still computes a non-zero fee and fee rate across the BigInt path', function () {
            const psbt = finalizedPsbt(9007199254740993n, 9007199254740000n);  // input above 2^53
            assert.strictEqual(psbt.getFee(), 993);
            assert.ok(psbt.getFeeRate() > 0);
            assert.ok(psbt.extractTransaction());
        });

        it('the all-Number fast path is unchanged', function () {
            const psbt = finalizedPsbt(100000, 90000);
            assert.strictEqual(psbt.getFee(), 10000);
            assert.ok(psbt.getFeeRate() > 0);
        });
    });
});

describe('applyBufferutilsPatch', function () {
    describe('twin guard against the SDK copy', function () {
        const repoRoot = path.resolve(__dirname, '../../..');
        const sdkRoot = findSdkRoot(repoRoot);
        const mine = path.join(__dirname, '../../../src/build/apply_bufferutils_patch.js');

        it('is byte-identical to the SDK copy below the banner', function () {
            if (!sdkRoot) return this.skip();
            const shared = ['compat.js', 'u64.js', 'v7.js', 'version.js'];
            for (const name of shared) {
                const encoderFile = path.join(repoRoot, 'src/build/apply_bufferutils_patch', name);
                const sdkFile = path.join(sdkRoot, 'src/utils/apply_bufferutils_patch', name);
                assert.ok(fs.existsSync(sdkFile), 'xchain-sdk is present but its patch module is missing: ' + sdkFile);
                assert.strictEqual(fs.readFileSync(encoderFile, 'utf8'), fs.readFileSync(sdkFile, 'utf8'),
                    name + ' has drifted from the SDK copy; converge SDK-ward');
            }
        });

        it('declares every package it deep-requires', function () {
            const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
            const sources = patchModuleSources(mine);
            assert.ok(sources.has(path.join(repoRoot, 'src/build/apply_bufferutils_patch/v7.js')),
                'dependency check did not reach the bitcoinjs-lib 7 patch module');
            const required = new Set();
            for (const source of sources.values()) {
                for (const match of source.matchAll(/require\('([^']+)'\)/g)) {
                    if (match[1].startsWith('.')) continue;
                    const parts = match[1].split('/');
                    required.add(match[1].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
                }
            }
            for (const name of required) {
                assert.ok(
                    Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, name),
                    name + ' is required by src/build/apply_bufferutils_patch.js but not declared in package.json dependencies'
                );
            }
        });

        it('does not pin bitcoinjs-lib transitive dependencies', function () {
            const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
            assert.strictEqual(Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, 'bip174'), false);
        });
    });
});
