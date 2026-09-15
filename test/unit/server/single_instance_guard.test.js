/*
 * Unit tests for the single-instance deploy guard.
 *
 * The outpoint-reservation store, the recent-build duplicate refusal behind it
 * and the rate-limiter store are all in-process; these tests pin the boot-time
 * guards that keep horizontally scaled or duplicate-process deploys from
 * silently racing UTXO selections, and pin that both refusal messages name
 * every in-process store a shared-store migration has to move.
 */

const assert = require('assert')

const { assertSingleInstance } = require('../../src/server/single_instance_guard')

describe('singleInstanceGuard', function () {

    describe('assertSingleInstance', function () {
        it('passes when ENCODER_REPLICAS is unset', function () {
            assert.strictEqual(assertSingleInstance({}), true)
        })

        it('passes when ENCODER_REPLICAS is empty', function () {
            assert.strictEqual(assertSingleInstance({ ENCODER_REPLICAS: '' }), true)
        })

        it('passes when ENCODER_REPLICAS=1', function () {
            assert.strictEqual(assertSingleInstance({ ENCODER_REPLICAS: '1' }), true)
        })

        it('throws when ENCODER_REPLICAS > 1', function () {
            assert.throws(
                () => assertSingleInstance({ ENCODER_REPLICAS: '2' }),
                /single-instance only/
            )
        })

        // The refusal is the deploy-time list of what a shared-store migration
        // has to move, so it names every in-process store, the recent-build
        // duplicate refusal (XChainEncoder `recentBuilds`) included.
        it('names every in-process store in the replica refusal', function () {
            let message = ''
            try { assertSingleInstance({ ENCODER_REPLICAS: '2' }) } catch (err) { message = err.message }
            for (const store of [/outpoint-reservation/, /recent-build/, /rate limiter/]) {
                assert.match(message, store, 'replica refusal must name ' + store)
            }
        })

        it('throws on non-integer values', function () {
            for (const bad of ['0', '-1', 'two', '1.5', 'NaN']) {
                assert.throws(
                    () => assertSingleInstance({ ENCODER_REPLICAS: bad }),
                    /positive integer/,
                    'expected throw for ' + bad
                )
            }
        })
    })

})
