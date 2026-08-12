// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression tests for a fix to the obfuscation key binding: it must bind to
// the actual first input after a reservation skip, not the pre-selection
// utxos[0]. A related fix was reverted, so it is intentionally not covered here.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const { makeEncoder, makeSegwitUtxo, getTestAddress, TXID_A, TXID_B } = require('./helpers/utxoFactory')
const { deobfuscate } = require('./helpers/deobfuscate')
const actions = require('./helpers/actionFactory')

const NETWORK = 'dogecoin-regtest'
const MAGIC = 'XCHN'

describe('encoder stress-sweep @regression', function () {
    this.timeout(10000)

    describe('E1: obfuscation key binds to the ACTUAL first input after a reservation skip', function () {
        it('OP_RETURN action decodes with ins[0].txid when the largest utxo was reserved', async function () {
            const encoder = makeEncoder(NETWORK)
            const address = getTestAddress(NETWORK)
            // The tracker returns two equal-value UTXOs; sort keeps TXID_A first. A prior/
            // concurrent create_tx already reserved TXID_A, so the real first input is TXID_B.
            encoder.utxoTrackerConnector = {
                getUtxosFromAddress: async () => ({
                    utxos: [makeSegwitUtxo(TXID_A, 0, 100000000), makeSegwitUtxo(TXID_B, 0, 100000000)]
                })
            }
            encoder._reserveOutpoint(TXID_A + ':0', Date.now())

            const action = actions.makeSend('JDOG', '42', actions.ADDR_BTC)
            // No utxos passed -> fetched from tracker (fetchedFromTracker = true).
            const result = await encoder.createTransaction(
                null, address, null, action.data, null, 10000, false, null, address,
                null, null, null, true, 0.00001
            )

            // ins[0] must be the non-reserved UTXO (TXID_A was skipped).
            const ins0Txid = Buffer.from(result.psbt.txInputs[0].hash).reverse().toString('hex')
            assert.strictEqual(ins0Txid, TXID_B, 'ins[0] must be the non-reserved utxo')

            const opReturn = result.psbt.txOutputs.find(o => o.value === 0)
            const obf = bitcoin.script.decompile(opReturn.script)[1]

            // The action decodes with ins[0].txid -> the key bound to the real first input.
            assert.strictEqual(deobfuscate(obf, ins0Txid).subarray(0, 4).toString('utf8'), MAGIC,
                'action must decode with ins[0].txid (the decoder uses ins[0])')
            // ...and NOT with the old buggy key (the pre-selection utxos[0] = TXID_A).
            assert.notStrictEqual(deobfuscate(obf, TXID_A).subarray(0, 4).toString('utf8'), MAGIC,
                'must not decode with the reserved/skipped utxos[0].txid')
        })

        it('caller-supplied UTXOs are unaffected: key binds to utxos[0] as before', async function () {
            const encoder = makeEncoder(NETWORK)
            const address = getTestAddress(NETWORK)
            const action = actions.makeSend()
            const result = await encoder.createTransaction(
                [makeSegwitUtxo(TXID_A, 0, 100000000)], address, null, action.data, null, 10000, false, null, address,
                null, null, null, true, 0.00001
            )
            const ins0Txid = Buffer.from(result.psbt.txInputs[0].hash).reverse().toString('hex')
            assert.strictEqual(ins0Txid, TXID_A)
            const opReturn = result.psbt.txOutputs.find(o => o.value === 0)
            const obf = bitcoin.script.decompile(opReturn.script)[1]
            assert.strictEqual(deobfuscate(obf, TXID_A).subarray(0, 4).toString('utf8'), MAGIC)
        })
    })

})
