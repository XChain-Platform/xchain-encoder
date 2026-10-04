'use strict';

const assert = require('node:assert/strict');

const {
    buildPin,
    comparable,
    differences,
    COINS_FILES,
    VENDORED_TWIN_FILES,
} = require('../../../bin/pin-identity.js');

describe('identity pin tool', () => {
    it('exports the complete ordered identity file lists', () => {
        assert.deepEqual(COINS_FILES, [
            'src/coins/BTC.js',
            'src/coins/LTC.js',
            'src/coins/DOGE.js',
            'src/coins/index.js',
            'src/coins/consensus_pin.js',
        ]);
        assert.deepEqual(VENDORED_TWIN_FILES, [
            '.github/workflows/verify-tag.yml',
            'src/observability/README.md',
            'src/observability/index.js',
            'src/observability/logShipper.js',
            'src/observability/metrics.js',
            'test/fixtures/action-manifest.json',
            'test/fixtures/roundtrip-conformance.json',
            'test/fixtures/utxo-record-conformance.json',
            'tools/release/release-signing-fingerprint.txt',
            'tools/release/release-signing-key.asc',
        ]);
    });

    it('builds hashes for every tracked identity file', () => {
        const pin = buildPin();
        assert.deepEqual(Object.keys(pin.coins), COINS_FILES);
        assert.deepEqual(Object.keys(pin.vendoredTwins), VENDORED_TWIN_FILES);
        assert.match(pin.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
        for (const digest of [...Object.values(pin.coins), ...Object.values(pin.vendoredTwins)]) {
            assert.match(digest, /^[a-f0-9]{64}$/);
        }
    });

    it('compares a freshly built pin equal to itself', () => {
        const pin = comparable(buildPin());
        assert.deepEqual(differences(pin, pin), []);
    });

    it('reports exactly one changed coin digest', () => {
        const pin = buildPin();
        const changed = structuredClone(pin);
        const changedFile = COINS_FILES[0];
        changed.coins[changedFile] = '0'.repeat(64);
        assert.deepEqual(
            differences(comparable(pin), comparable(changed)),
            [`coins:${changedFile}:hash`],
        );
    });

    it('normalizes comparable values in deterministic key order', () => {
        const normalized = comparable({ vendoredTwins: { z: 'last', a: 'first' }, capturedAt: 'ignored' });
        assert.deepEqual(Object.keys(normalized), [
            'coins',
            'coinsNote',
            'vendoredTwins',
            'vendoredTwinsNote',
        ]);
        assert.equal(
            JSON.stringify(normalized),
            '{"coins":{},"coinsNote":null,"vendoredTwins":{"z":"last","a":"first"},"vendoredTwinsNote":null}',
        );
    });
});
