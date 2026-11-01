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
 * bitcoinjs-lib 7 part: BigInt-valued satoshis with Number-compatible callers.
 *
 ********************************************************************/

const bufferutils = require('bitcoinjs-lib/src/bufferutils')
const bitcoinTypes = require('bitcoinjs-lib/src/types')
const bitcoin = require('bitcoinjs-lib')
const valibot = require('valibot')
const uint8Tools = require('uint8array-tools')
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')
const { IS_BITCOINJS_V7 } = require('./version')
const { MAX_U64, MAX_SAFE_BIG, verifyU64, narrowU64 } = require('./u64')
const {
    withBigIntValue,
    withBigIntWitnessUtxo,
    compatibleValue,
    compatiblePayment,
    compatibleTransaction,
    bufferize,
    compatiblePsbt,
} = require('./compat')
const { Psbt, Transaction } = bitcoin

if (IS_BITCOINJS_V7 && !Transaction.prototype.__xchainNumberValues) {
    bitcoinTypes.SatoshiSchema = valibot.pipe(
        valibot.bigint(), valibot.minValue(0n), valibot.maxValue(MAX_U64)
    )
    const canPatchUint8Tools = Object.isExtensible(uint8Tools)
        && ['writeInt64', 'readInt64'].every((name) => {
            const descriptor = Object.getOwnPropertyDescriptor(uint8Tools, name)
            return !descriptor || descriptor.writable || typeof descriptor.set === 'function'
        })
    if (canPatchUint8Tools) {
        uint8Tools.writeInt64 = uint8Tools.writeUInt64
        uint8Tools.readInt64 = uint8Tools.readUInt64
    }
    bufferutils.readUInt64LE = function (buffer, offset) {
        return narrowU64(uint8Tools.readUInt64(buffer, offset, 'LE'))
    }
    bufferutils.writeUInt64LE = function (buffer, value, offset) {
        uint8Tools.writeUInt64(buffer, offset, verifyU64(value), 'LE')
        return offset + 8
    }
    bufferutils.BufferWriter.prototype.writeInt64 = function (value) {
        this.offset = uint8Tools.writeUInt64(this.buffer, this.offset, verifyU64(value), 'LE')
    }
    bufferutils.BufferWriter.prototype.writeUInt64 = bufferutils.BufferWriter.prototype.writeInt64
    bufferutils.BufferReader.prototype.readInt64 = function () {
        const value = uint8Tools.readUInt64(this.buffer, this.offset, 'LE')
        this.offset += 8
        return value
    }
    bufferutils.BufferReader.prototype.readUInt64 = function () {
        const value = narrowU64(uint8Tools.readUInt64(this.buffer, this.offset, 'LE'))
        this.offset += 8
        return value
    }

    const varuint = bufferutils.varuint
    const encodeVarInt = function (value, buffer, offset) {
        const result = varuint.encode(value, buffer, offset)
        encodeVarInt.bytes = result.bytes
        return compatibleValue(result.buffer)
    }
    const decodeVarInt = function (buffer, offset) {
        const result = varuint.decode(buffer, offset)
        decodeVarInt.bytes = result.bytes
        return result.numberValue === null ? result.bigintValue : result.numberValue
    }
    bufferutils.varuint = {
        encode: encodeVarInt,
        decode: decodeVarInt,
        encodingLength: varuint.encodingLength,
    }

    const addOutput = Transaction.prototype.addOutput
    Transaction.prototype.addOutput = function (script, value) {
        return addOutput.call(this, script, typeof value === 'number' ? verifyU64(value) : value)
    }
    Transaction.prototype.__xchainNumberValues = true

    const fromBuffer = Transaction.fromBuffer
    Transaction.fromBuffer = function (...args) {
        return compatibleTransaction(fromBuffer.apply(this, args), false)
    }
    const fromHex = Transaction.fromHex
    Transaction.fromHex = function (...args) {
        return compatibleTransaction(fromHex.apply(this, args), true)
    }
    const getHash = Transaction.prototype.getHash
    Transaction.prototype.getHash = function (...args) {
        return compatibleValue(getHash.apply(this, args))
    }
    const toBuffer = Transaction.prototype.toBuffer
    Transaction.prototype.toBuffer = function (...args) {
        return compatibleValue(toBuffer.apply(this, args))
    }
    const hashForWitnessV0 = Transaction.prototype.hashForWitnessV0
    Transaction.prototype.hashForWitnessV0 = function (index, script, value, hashType) {
        return compatibleValue(hashForWitnessV0.call(
            this, index, script, typeof value === 'number' ? verifyU64(value) : value, hashType
        ))
    }
    const hashForWitnessV1 = Transaction.prototype.hashForWitnessV1
    Transaction.prototype.hashForWitnessV1 = function (index, scripts, values, ...args) {
        return compatibleValue(hashForWitnessV1.call(
            this, index, scripts, values.map((value) => typeof value === 'number' ? verifyU64(value) : value), ...args
        ))
    }

    const addInput = Psbt.prototype.addInput
    Psbt.prototype.addInput = function (data) {
        const result = addInput.call(this, withBigIntWitnessUtxo(data))
        bufferize(this.data.inputs[this.data.inputs.length - 1])
        return result
    }
    const updateInput = Psbt.prototype.updateInput
    Psbt.prototype.updateInput = function (index, data) {
        const result = updateInput.call(this, index, withBigIntWitnessUtxo(data))
        bufferize(this.data.inputs[index])
        return result
    }
    const addPsbtOutput = Psbt.prototype.addOutput
    Psbt.prototype.addOutput = function (data) {
        const result = addPsbtOutput.call(this, withBigIntValue(data))
        bufferize(this.data.outputs[this.data.outputs.length - 1])
        return result
    }

    const psbtFromBuffer = Psbt.fromBuffer
    Psbt.fromBuffer = function (...args) {
        return compatiblePsbt(psbtFromBuffer.apply(this, args))
    }

    for (const name of ['signInput', 'signAllInputs', 'finalizeInput', 'finalizeAllInputs']) {
        const method = Psbt.prototype[name]
        Psbt.prototype[name] = function (...args) {
            const result = method.apply(this, args)
            compatiblePsbt(this)
            return result
        }
    }

    for (const name of ['txInputs', 'txOutputs']) {
        const descriptor = Object.getOwnPropertyDescriptor(Psbt.prototype, name)
        Object.defineProperty(Psbt.prototype, name, Object.assign({}, descriptor, {
            get() {
                return bufferize(descriptor.get.call(this))
            }
        }))
    }

    const extractTransaction = Psbt.prototype.extractTransaction
    Psbt.prototype.extractTransaction = function (...args) {
        return compatibleTransaction(extractTransaction.apply(this, args), true)
    }
    const getFee = Psbt.prototype.getFee
    Psbt.prototype.getFee = function (...args) {
        const fee = getFee.apply(this, args)
        return typeof fee === 'bigint' && fee <= MAX_SAFE_BIG ? Number(fee) : fee
    }
    const psbtToBuffer = Psbt.prototype.toBuffer
    Psbt.prototype.toBuffer = function (...args) {
        return compatibleValue(psbtToBuffer.apply(this, args))
    }

    for (const name of Object.keys(bitcoin.payments)) {
        const payment = bitcoin.payments[name]
        if (typeof payment !== 'function') continue
        Object.defineProperty(bitcoin.payments, name, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: function (...args) {
                return compatiblePayment(payment.apply(this, args))
            },
        })
    }
    for (const group of [bitcoin.script, bitcoin.crypto]) {
        for (const name of Object.keys(group)) {
            const fn = group[name]
            if (typeof fn !== 'function') continue
            Object.defineProperty(group, name, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: function (...args) {
                    return compatibleValue(fn.apply(this, args))
                },
            })
        }
    }
    for (const name of Object.keys(psbtutils)) {
        const fn = psbtutils[name]
        if (typeof fn !== 'function') continue
        psbtutils[name] = function (...args) {
            return compatibleValue(fn.apply(this, args))
        }
    }
}
