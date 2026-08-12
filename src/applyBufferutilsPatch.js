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
 * In-process BigInt-safe 64-bit value patch for bitcoinjs-lib + bip174.
 *
 * Stock bitcoinjs-lib 6.x holds transaction output values as Number and
 * bounds them twice: the 64-bit serializers (bufferutils verifuint, and
 * bip174's own copy for the PSBT witnessUtxo field) throw 'RangeError:
 * value out of range' above 2^53-1, and types.Satoshi additionally caps
 * addOutput at 21M BTC in sats (2.1e15). Dogecoin has no supply cap, so a
 * single output can legitimately exceed both ceilings (>~90.07M DOGE for
 * 2^53); without this patch the encoder cannot build such a PSBT at all.
 * Sibling of xchain-decoder/src/applyBufferutilsPatch.js, which
 * fixes the same 2^53 wall on the read side of the pipeline.
 *
 * The patch teaches the loaded modules to carry a satoshi value as either
 * a Number (unchanged fast path) or a BigInt up to 2^64-1 (the wire
 * format's true ceiling). Readers return a Number whenever the value is
 * exactly representable and a BigInt only above 2^53-1, so existing
 * Number-based callers see identical behavior for every value they could
 * already handle.
 *
 * All bitcoinjs-lib/bip174 consumers hold the patched modules' exports
 * objects and class prototypes rather than destructured copies, so
 * mutating them here retrofits every current and future caller.
 *
 ********************************************************************/

const bufferutils = require('bitcoinjs-lib/src/bufferutils')
const bitcoinTypes = require('bitcoinjs-lib/src/types')
const bip174Tools = require('bip174/src/lib/converter/tools')

const MAX_U64 = 0xffffffffffffffffn
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER)

// Bounds-check a satoshi value that may be a Number or a BigInt, mirroring
// stock verifuint's error strings so callers relying on them keep working.
function verifyU64(value) {
    if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error('cannot write a non-number as a number')
    }
    if (typeof value === 'number' && Math.floor(value) !== value) {
        throw new Error('value has a fractional component')
    }
    const big = BigInt(value)
    if (big < 0n) {
        throw new Error('specified a negative value for writing an unsigned value')
    }
    if (big > MAX_U64) {
        throw new Error('RangeError: value out of range')
    }
    return big
}

// Number when exactly representable, BigInt above 2^53-1. Keeps every
// pre-patch caller seeing the same type it always saw.
function narrowU64(big) {
    return big <= MAX_SAFE_BIG ? Number(big) : big
}

// Probe with a 2^53 uint64, one past the stock serializers' ceiling: stock
// code throws, the patched reader returns it. Idempotence guard (the patch
// may already be active when several entry points require this module).
function bigIntReaderActive(bu) {
    try {
        new bu.BufferReader(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0])).readUInt64()
        return true
    } catch (_) {
        return false
    }
}

if (!bigIntReaderActive(bufferutils)) {
    bufferutils.readUInt64LE = function readUInt64LE(buffer, offset) {
        return narrowU64(buffer.readBigUInt64LE(offset))
    }

    bufferutils.writeUInt64LE = function writeUInt64LE(buffer, value, offset) {
        buffer.writeBigUInt64LE(verifyU64(value), offset)
        return offset + 8
    }

    bufferutils.BufferReader.prototype.readUInt64 = function readUInt64() {
        // Bitcoin wire tx output value is an UNSIGNED 64-bit LE integer; the
        // signed reader would decode a value >= 2^63 as a negative BigInt.
        const result = narrowU64(this.buffer.readBigUInt64LE(this.offset))
        this.offset += 8
        return result
    }

    bufferutils.BufferWriter.prototype.writeUInt64 = function writeUInt64(value) {
        this.offset = this.buffer.writeBigUInt64LE(verifyU64(value), this.offset)
    }
}

// types.Satoshi gates Transaction.addOutput (typeforce). Stock form is
// UInt53(value) && value <= 21e14, a bitcoin-specific supply cap that is
// simply wrong for Dogecoin (no cap). Accept any exact u64: Number up to
// 2^53-1, BigInt up to 2^64-1. Upstream validators (validator.js
// parseSatoshiAmount) remain the semantic bound for caller input.
if (!bitcoinTypes.Satoshi(MAX_U64)) {
    bitcoinTypes.Satoshi = function Satoshi(value) {
        if (typeof value === 'bigint') return value >= 0n && value <= MAX_U64
        return bitcoinTypes.typeforce.UInt53(value)
    }
}

// bip174 carries its own 64-bit serializer copy for the PSBT witnessUtxo
// value field; patch it the same way or a >2^53 segwit input value would
// still throw at PSBT serialization time.
if (!(() => { try { bip174Tools.readUInt64LE(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0]), 0); return true } catch (_) { return false } })()) {
    bip174Tools.readUInt64LE = function readUInt64LE(buffer, offset) {
        return narrowU64(buffer.readBigUInt64LE(offset))
    }

    bip174Tools.writeUInt64LE = function writeUInt64LE(buffer, value, offset) {
        buffer.writeBigUInt64LE(verifyU64(value), offset)
        return offset + 8
    }
}

// bip174's witnessUtxo converter type-check hard-codes
// `typeof data.value === 'number'`, so a BigInt input value is rejected at
// Psbt.addInput before serialization. Widen it to accept BigInt too.
const witnessUtxoConverter = require('bip174/src/lib/converter/input/witnessUtxo')
if (!witnessUtxoConverter.check({ script: Buffer.alloc(1), value: 1n })) {
    witnessUtxoConverter.check = function check(data) {
        return Buffer.isBuffer(data.script) &&
            (typeof data.value === 'number' || typeof data.value === 'bigint')
    }
    witnessUtxoConverter.expected = '{ script: Buffer; value: number | bigint; }'
}

// psbt.js's internal PsbtTransaction wrapper (not exported) hard-codes
// `typeof output.value !== 'number'` in addOutput, so a BigInt value throws
// 'Error adding output.' before it ever reaches the patched serializers.
// Reach its prototype through a throwaway Psbt instance and widen the check.
const { Psbt, Transaction } = require('bitcoinjs-lib')
const psbtTxProto = Object.getPrototypeOf(new Psbt().data.globalMap.unsignedTx)
if (!psbtTxProto.__xchainBigIntValues) {
    psbtTxProto.addOutput = function addOutput(output) {
        if (
            output.script === undefined ||
            output.value === undefined ||
            !Buffer.isBuffer(output.script) ||
            (typeof output.value !== 'number' && typeof output.value !== 'bigint')
        ) {
            throw new Error('Error adding output.')
        }
        this.tx.addOutput(output.script, output.value)
    }
    psbtTxProto.__xchainBigIntValues = true
}

// psbt.js's internal fee accounting (inputFinalizeGetAmts) sums input and
// output values with Number '+', which throws 'Cannot mix BigInt and other
// types' once any value is a BigInt. It runs inside extractTransaction /
// getFee / getFeeRate via module-internal closures we cannot reach, so wrap
// the public methods instead: try the stock implementation first (zero
// behavior change for all-Number PSBTs) and, only on the BigInt-mixing
// TypeError, recompute the amounts BigInt-safely, prime the caches the
// stock helper would have primed, and re-run the stock method (which then
// returns the cached result).
function witnessStackFromScriptWitness(buffer) {
    // Inverse of psbt.js's internal scriptWitnessToWitnessStack: a varint
    // element count followed by var-sliced witness elements.
    let offset = 0
    const readVarInt = () => {
        const vi = bufferutils.varuint.decode(buffer, offset)
        offset += bufferutils.varuint.decode.bytes
        return vi
    }
    const count = readVarInt()
    const vector = []
    for (let i = 0; i < count; i++) {
        const n = readVarInt()
        vector.push(buffer.slice(offset, offset + n))
        offset += n
    }
    return vector
}

function primeBigIntSafeAmts(psbt) {
    const c = psbt.__CACHE
    const tx = c.__TX.clone()
    let inputAmount = 0n
    psbt.data.inputs.forEach((input, idx) => {
        if (input.finalScriptSig) tx.ins[idx].script = input.finalScriptSig
        if (input.finalScriptWitness) {
            tx.ins[idx].witness = witnessStackFromScriptWitness(input.finalScriptWitness)
        }
        if (input.witnessUtxo) {
            inputAmount += BigInt(input.witnessUtxo.value)
        } else if (input.nonWitnessUtxo) {
            const nwTx = Transaction.fromBuffer(input.nonWitnessUtxo)
            inputAmount += BigInt(nwTx.outs[tx.ins[idx].index].value)
        }
    })
    const outputAmount = tx.outs.reduce((total, o) => total + BigInt(o.value), 0n)
    const fee = inputAmount - outputAmount
    if (fee < 0n) {
        throw new Error('Outputs are spending more than Inputs')
    }
    // Fees are always tiny relative to 2^53; Number() is exact in practice
    // and the cached fee is only used for the fee-rate sanity check anyway.
    const feeNumber = Number(fee)
    c.__FEE = feeNumber
    c.__EXTRACTED_TX = tx
    c.__FEE_RATE = Math.floor(feeNumber / tx.virtualSize())
}

if (!Psbt.prototype.__xchainBigIntAmts) {
    for (const method of ['extractTransaction', 'getFee', 'getFeeRate']) {
        const stock = Psbt.prototype[method]
        Psbt.prototype[method] = function (...args) {
            try {
                return stock.apply(this, args)
            } catch (err) {
                if (!(err instanceof TypeError) || !/BigInt/.test(err.message)) throw err
                primeBigIntSafeAmts(this)
                return stock.apply(this, args)
            }
        }
        Object.defineProperty(Psbt.prototype[method], 'name', { value: method })
    }
    Psbt.prototype.__xchainBigIntAmts = true
}

module.exports = bufferutils
