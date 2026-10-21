/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Buffer/Uint8Array and BigInt value shims used by the bitcoinjs-lib 7 part.
 *
 ********************************************************************/

const { MAX_SAFE_BIG, verifyU64 } = require('./u64')

function withBigIntValue(data) {
    if (!data || typeof data.value !== 'number') return data
    return Object.assign({}, data, { value: verifyU64(data.value) })
}

function withBigIntWitnessUtxo(data) {
    if (!data || !data.witnessUtxo || typeof data.witnessUtxo.value !== 'number') return data
    return Object.assign({}, data, { witnessUtxo: withBigIntValue(data.witnessUtxo) })
}

function compatibleValue(value) {
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value)
    if (Array.isArray(value)) return value.map(compatibleValue)
    return value
}

function compatiblePayment(payment) {
    if (!payment || typeof payment !== 'object') return payment
    for (const name of Object.getOwnPropertyNames(payment)) {
        const descriptor = Object.getOwnPropertyDescriptor(payment, name)
        if (descriptor.get) {
            Object.defineProperty(payment, name, Object.assign({}, descriptor, {
                get() { return compatibleValue(descriptor.get.call(this)) }
            }))
        } else if ('value' in descriptor) {
            payment[name] = compatibleValue(descriptor.value)
        }
    }
    return payment
}

function compatibleTransaction(tx, narrowValues) {
    for (const input of tx.ins) {
        input.hash = compatibleValue(input.hash)
        input.script = compatibleValue(input.script)
        input.witness = compatibleValue(input.witness)
    }
    for (const output of tx.outs) {
        output.script = compatibleValue(output.script)
        if (narrowValues && typeof output.value === 'bigint' && output.value <= MAX_SAFE_BIG) {
            output.value = Number(output.value)
        }
    }
    return tx
}

function bufferize(value) {
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value)
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = bufferize(value[i])
        return value
    }
    if (value && typeof value === 'object') {
        for (const name of Object.keys(value)) value[name] = bufferize(value[name])
    }
    return value
}

function compatiblePsbt(psbt) {
    bufferize(psbt.data.globalMap)
    bufferize(psbt.data.inputs)
    bufferize(psbt.data.outputs)
    return psbt
}

module.exports = {
    withBigIntValue,
    withBigIntWitnessUtxo,
    compatibleValue,
    compatiblePayment,
    compatibleTransaction,
    bufferize,
    compatiblePsbt,
}
