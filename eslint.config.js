/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * eslint flat config: the file-level half of the code-style rules, for
 * editors and `npm run lint`.
 *
 * VENDORED BY COPY from the platform's master preset rather than imported: a
 * public clone of this repo has no platform tree beside it to import from.
 * Core rules only, no plugins, so this file adds exactly one devDependency.
 * Changes belong in the master copy first and travel here as a re-vendor;
 * this repo adds no rules of its own.
 */
'use strict';

const src = {
    files: ['src/**/*.js'],
    languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'commonjs',
        globals: {
            require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', Buffer: 'readonly',
            __dirname: 'readonly', __filename: 'readonly', console: 'readonly', setTimeout: 'readonly',
            clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
            URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly',
        },
    },
    rules: {
        // Naming: camelCase everywhere except property keys, which carry
        // protocol fields and DB columns through one-to-one.
        camelcase: ['error', {
            properties: 'never',
            ignoreDestructuring: true,
            ignoreImports: true,
            allow: [
                'tracker_reachable', 'tracker_synced', 'tracker_lag', 'tracker_halted',
                'tracker_mempool_ready', 'tracker_max_lag_blocks', 'node_tier_mismatch',
                'node_tier_checked', 'request_gate', 'probe_gate',
            ],
        }],
        'no-underscore-dangle': ['error', {
            enforceInMethodNames: true,
            allowAfterThis: false,
            allowFunctionParams: false,
            allow: [
                '_router', '_m', '_getActiveHandles', '__TX', '__CACHE', '_nodeModulePaths', '_compile',
                '_buildTransaction', '__xchainNumberValues', '_chainNameCache', '_post', '_attachMetrics',
                '_startTimer', '_levelCounter', '_emitLocal', '_enqueue', '_noteError', '_key',
                '_normalizeLabels', '_series', '_noteSeriesDrop', '_register', '_origToHex',
                '_origAddInput', '_origAddOutput', '_origCreateCipheriv', '_origCompile', '_samples',
                '_count', '_sorted', '_ensureSorted', '_intervalMs', '_timer', '_snapshots', '_pauses',
                '_observer', '_histogram', '_envKeys', '_savedEnv', '_code', '_json',
                '_resetObservability', '_logger', '_registry', '_patched', '_shipperAttached', '_sink',
                '_unmatchedRouteLabels', '_lazyLogger', '_suggestedFeeClampWarned', '_maxFeeRateKb',
                '_maxFeeRateMultiplier', '_utxoTrackerMaxLagBlocks', '_dustAmount', '_auth', '_base',
                '_wallet', '_rpc',
            ],
        }],
        // Logging: one logger. Entry points override this below.
        'no-console': 'error',
        // Module shape: requires at the top, environment in config.js only,
        // one export shape per file.
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
            {
                selector: 'MemberExpression[object.name="process"][property.name="env"]',
                message: 'environment is read in config.js only (CODE-STYLE.md, Module shape)',
            },
        ],
        'prefer-const': 'error',
        'no-var': 'error',
        eqeqeq: ['error', 'smart'],
    },
};

const configAndEntry = {
    files: [
        'src/common/config.js',
        'src/api.js',
        'src/migrate.js',
        'src/index.js',
        'src/coins/index.js',
        'src/observability/index.js',
        'src/observability/logShipper.js',
        'src/server/rate_limit_log.js',
        'bin/**/*.js',
    ],
    rules: {
        'no-console': 'off',
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
        ],
    },
};

const tests = {
    files: ['test/**/*.js'],
    languageOptions: src.languageOptions,
    rules: {
        camelcase: src.rules.camelcase,
        'no-underscore-dangle': src.rules['no-underscore-dangle'],
        'prefer-const': 'error',
        'no-var': 'error',
    },
};

const moduleTests = {
    files: [
        'test/performance/helpers/k6/*.js',
        'test/xchain_encoder.test.js',
        'test/xchain_encoder.test/*.js',
    ],
    languageOptions: {
        ...src.languageOptions,
        sourceType: 'module',
    },
};

module.exports = [src, configAndEntry, tests, moduleTests];
