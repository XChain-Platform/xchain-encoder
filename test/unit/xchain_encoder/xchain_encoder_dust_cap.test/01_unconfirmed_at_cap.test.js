'use strict';

const assert = require('assert')
const {
    makeUtxo,
    makeMempoolUtxo,
    makeTrackerEnvelope,
    makeEncoder,
    getTestAddress
} = require('../../../integration/helpers/utxoFactory')

const NETWORK = 'bitcoin-regtest'
const INPUT_CAP = 500

function dustSet(count, value = 20) {
    const utxos = []
    for (let i = 0; i < count; i++) {
        const txid = (i + 1).toString(16).padStart(64, '0')
        utxos.push(makeUtxo(NETWORK, txid, 0, value))
    }
    return utxos
}

function buildFromTracker(utxos, unconfirmed, fee) {
    const encoder = makeEncoder(NETWORK)
    const address = getTestAddress(NETWORK)
    encoder.utxoTrackerConnector.getUtxosFromAddress = async () => makeTrackerEnvelope(utxos)
    return encoder.createTransaction(
        null, address, null, 'test', null, fee, false, null, address,
        null, null, null, unconfirmed, 0.00001
    )
}

function isCappedSelection(error) {
    return error.operational === true &&
        error.xchainCode === 'NO_CONFIRMED_UTXO' &&
        error.details.selectedInputCount === INPUT_CAP &&
        error.details.maximum === INPUT_CAP
}

describe('tracker-funded selection at the input cap', function () {
    this.timeout(30000)

    it('uses a large unconfirmed output before 1,082 confirmed dust outputs when allowed', async function () {
        const utxos = dustSet(1082)
        utxos.push(makeMempoolUtxo('f'.repeat(64), 0, 100000000))

        const result = await buildFromTracker(utxos, true, 10000)

        assert.strictEqual(result.psbt.data.inputs.length, 1)
        assert.strictEqual(Buffer.from(result.psbt.txInputs[0].hash).reverse().toString('hex'), 'f'.repeat(64))
    })

    it('returns a retryable operational error for an all-confirmed selection at the cap', async function () {
        await assert.rejects(
            () => buildFromTracker(dustSet(1082), true, 25000),
            isCappedSelection
        )
    })

    it('returns the same operational error when unconfirmed outputs are excluded', async function () {
        const utxos = dustSet(1082)
        utxos.push(makeMempoolUtxo('f'.repeat(64), 0, 100000000))

        await assert.rejects(
            () => buildFromTracker(utxos, false, 25000),
            isCappedSelection
        )
    })

    it('preserves the range error when additional inputs could fund the transaction', async function () {
        await assert.rejects(
            () => buildFromTracker(dustSet(600, 50), true, 25000),
            (error) => error instanceof RangeError && /selected input count/.test(error.message)
        )
    })
})
