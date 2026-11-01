const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const nestedTestEnv = 'XCHAIN_ENCODER_OFFLINE_NESTED_TEST';

function snapshotUnignoredFiles(repoRoot) {
    const output = childProcess.execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: repoRoot },
    );

    return output.toString()
        .split('\0')
        .filter(Boolean)
        .sort()
        .map((relativePath) => {
            const filePath = path.join(repoRoot, relativePath);
            let stat;

            try {
                stat = fs.lstatSync(filePath, { bigint: true });
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return [relativePath, 'missing'];
                }
                throw error;
            }

            const contents = stat.isSymbolicLink()
                ? fs.readlinkSync(filePath)
                : fs.readFileSync(filePath);
            const digest = crypto.createHash('sha256').update(contents).digest('hex');

            return [relativePath, `${stat.mode}:${stat.mtimeNs}:${digest}`];
        });
}

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

    it('writes nothing outside ignored paths during npm test', function () {
        if (process.env[nestedTestEnv] === '1') {
            return;
        }

        this.timeout(120000);

        const before = snapshotUnignoredFiles(repoRoot);
        const npmExecPath = process.env.npm_execpath;
        const command = npmExecPath ? process.execPath : 'npm';
        const args = npmExecPath ? [npmExecPath, 'test'] : ['test'];
        const result = childProcess.spawnSync(command, args, {
            cwd: repoRoot,
            env: {
                ...process.env,
                [nestedTestEnv]: '1',
            },
            stdio: 'ignore',
        });

        assert.ifError(result.error);
        assert.equal(result.signal, null, 'nested npm test must complete');
        assert.deepEqual(snapshotUnignoredFiles(repoRoot), before);
    });
});
