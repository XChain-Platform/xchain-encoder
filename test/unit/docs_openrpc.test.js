// Unit coverage for the docs component (docs/openrpc.build.js ->
// docs/openrpc.json). The OpenRPC document is the published contract for the
// encoder's JSON-RPC surface; a malformed or truncated build ships a broken
// API reference. This pins the generated artifact's shape without invoking
// the (side-effecting) build script.

const assert = require('assert');
const doc = require('../../docs/openrpc.json');

describe('docs/openrpc.json', function () {
    it('declares an OpenRPC version and info block', function () {
        assert.strictEqual(typeof doc.openrpc, 'string');
        assert.ok(/^\d+\.\d+\.\d+$/.test(doc.openrpc), 'openrpc must be semver');
        assert.ok(doc.info && typeof doc.info.title === 'string' && doc.info.title.length > 0);
    });

    it('exposes a non-empty, well-formed methods array', function () {
        assert.ok(Array.isArray(doc.methods), 'methods must be an array');
        assert.ok(doc.methods.length > 0, 'at least one method must be documented');
        for (const m of doc.methods) {
            assert.strictEqual(typeof m.name, 'string', 'each method needs a name');
            assert.ok(m.name.length > 0);
            assert.ok(Array.isArray(m.params), `${m.name} must declare params[]`);
        }
    });

    it('has unique method names', function () {
        const names = doc.methods.map((m) => m.name);
        assert.strictEqual(new Set(names).size, names.length, 'method names must be unique');
    });

    it('documents the ping health method', function () {
        assert.ok(doc.methods.some((m) => m.name === 'ping'), 'ping method must be documented');
    });
});
