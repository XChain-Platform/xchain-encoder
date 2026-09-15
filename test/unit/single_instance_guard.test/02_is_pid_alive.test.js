const assert = require('assert')

const { isPidAlive } = require('../../../src/server/single_instance_guard')

describe('singleInstanceGuard', function () {
    describe('isPidAlive', function () {
        it('reports our own pid alive', function () {
            assert.strictEqual(isPidAlive(process.pid), true)
        })
    })
})
