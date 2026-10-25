const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('offline npm test lifecycle', () => {
    const repoRoot = path.join(__dirname, '../..');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');

    it('uses only local, side-effect-free commands before and during unit tests', () => {
        assert.equal(pkg.scripts.pretest, 'node --check test/unit/pretest_offline.test.js');
        assert.match(pkg.scripts.test, /^mocha\b/);

        const lifecycle = `${pkg.scripts.pretest} && ${pkg.scripts.test}`;
        assert.doesNotMatch(lifecycle, /\bnpx\b/);
        assert.doesNotMatch(lifecycle, /\b(?:npm|pnpm|yarn)\s+(?:ci|i|install|add)\b/);
    });

    it('ignores the repository scratch directory', () => {
        const entries = gitignore.split(/\r?\n/).map((line) => line.trim());
        assert.ok(entries.includes('tmp/'), 'tmp/ must be ignored');
    });
});
