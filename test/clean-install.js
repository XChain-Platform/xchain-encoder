const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const scratchRoot = path.join(repoRoot, 'tmp');
fs.mkdirSync(scratchRoot, { recursive: true });
const installRoot = fs.mkdtempSync(path.join(scratchRoot, 'clean-install-'));

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: installRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0) {
        process.stderr.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        throw new Error(`${path.basename(command)} exited with status ${result.status}`);
    }
    return result;
}

try {
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(installRoot, 'package.json'));
    const patchRoot = path.join(installRoot, 'src', 'build');
    fs.mkdirSync(patchRoot, { recursive: true });
    fs.copyFileSync(
        path.join(repoRoot, 'src', 'build', 'apply_bufferutils_patch.js'),
        path.join(patchRoot, 'apply_bufferutils_patch.js')
    );
    fs.cpSync(
        path.join(repoRoot, 'src', 'build', 'apply_bufferutils_patch'),
        path.join(patchRoot, 'apply_bufferutils_patch'),
        { recursive: true }
    );

    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, 'npm_execpath is required for isolated dependency verification');
    run(process.execPath, [
        npmCli,
        'install',
        '--ignore-scripts',
        '--omit=dev',
        '--package-lock=false',
        '--no-audit',
        '--no-fund',
        '--cache',
        path.join(scratchRoot, 'npm-cache')
    ]);

    const probe = `
        const assert = require('assert');
        const fs = require('fs');
        const manifest = require('./package.json');
        const installed = JSON.parse(fs.readFileSync('./node_modules/bitcoinjs-lib/package.json', 'utf8'));
        assert.strictEqual(installed.version, manifest.dependencies['bitcoinjs-lib']);
        assert.match(installed.version, /^7\\./);
        const bufferutils = require('./src/build/apply_bufferutils_patch');
        const value = 9007199254740993n;
        const buffer = Buffer.alloc(8);
        bufferutils.writeUInt64LE(buffer, value, 0);
        assert.strictEqual(bufferutils.readUInt64LE(buffer, 0), value);
    `;
    run(process.execPath, ['-e', probe]);
    process.stdout.write('Isolated bitcoinjs-lib 7 install and compatibility probe passed.\n');
} finally {
    fs.rmSync(installRoot, { recursive: true, force: true });
}
