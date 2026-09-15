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
 * XChain Encoder - Encoder Class
 *
 * This file handles starting the encoder and generating transactions
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib');
const TxSizeEstimator = require('../build/tx_size_estimator')
const { OP_RETURN_SIZE, MAGIC_WORD, Encoding } = require('./constants.js')
const { compactSizeLen } = require('./script_amount_helpers.js')

module.exports = {
    /*
     * Size-aware encoding selection: "smallest footprint by default" as the
     * platform's behaviour rather than its option. Only reached when the caller
     * explicitly asked for Encoding.AUTO.
     *
     * @param {number} compiledLength  the compiled ACTION stream, AFTER compression
     * @param {string|null} compressedPubKey  required for the envelope's internal key
     * @param {object|null} options   { signerSupportsTapscript }
     * @returns {string} a concrete Encoding
     */
    selectEncoding(compiledLength, compressedPubKey, options){
        const magicBytes = Buffer.from(MAGIC_WORD, 'utf8').length
        // Small payloads: one output, no reveal, nothing cheaper exists.
        if (compiledLength + magicBytes <= OP_RETURN_SIZE) return Encoding.OP_RETURN

        const segwit = this.network.supportsSegwit !== false

        // The envelope is ~2x cheaper per byte than P2WSH and replaces ~820
        // chunk outputs per 390 KB, so it wins whenever it is available. Two
        // conditions, both fail-closed:
        //
        //  - the network must have Taproot at all (DOGE never does);
        //  - the SIGNER must be able to produce a tapscript script-path
        //    signature. This defaults to NO and must be affirmed by the caller.
        //    The reveal has to be signable BEFORE the commit is broadcast;
        //    picking the envelope for a signer that cannot spend it does not
        //    produce an error message, it produces stranded funds. Hardware
        //    signers are the live case: the wallet's Trezor integration cannot
        //    sign the leaf today, so those accounts must land on P2WSH.
        const tapscriptSigner = !!(options && options.signerSupportsTapscript)
        if (segwit && tapscriptSigner && compressedPubKey) return Encoding.TAPROOT

        // P2WSH carries 476 bytes per chunk against MULTISIGN's 60, so it is the
        // segwit fallback. On a non-segwit chain P2SH is the same 476-byte lane
        // and is therefore preferred over MULTISIGN there too: AUTO never
        // selects the worst-density carrier, which is what makes MULTISIGN an
        // explicit-request-only lane from here on.
        if (segwit) return Encoding.P2WSH
        return Encoding.P2SH
    },

    // Stripped (non-witness) serialized byte count of a PSBT's underlying tx.
    // This is the size a node measures against its MIN_STANDARD_TX_NONWITNESS_SIZE
    // relay floor. P2WSH reveal inputs carry an empty scriptSig (all data lives in
    // the witness), so each contributes a fixed 41 non-witness bytes: 36-byte
    // outpoint + 1-byte empty-scriptSig length + 4-byte sequence.
    strippedTxSize(psbt){
        const varIntSize = (n) => n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9
        let size = 4 + 4 // version + locktime
        size = size + varIntSize(psbt.txInputs.length) + (41 * psbt.txInputs.length)
        size = size + varIntSize(psbt.txOutputs.length)
        for (let out of psbt.txOutputs){
            size = size + 8 + varIntSize(out.script.length) + out.script.length
        }
        return size
    },

    // Raise an already-emitted output's value in place.
    //
    // bitcoinjs exposes no setter for an output's value (updateOutput only
    // touches PSBT-level fields), and re-emitting the output is not an option:
    // the commit output's index is load-bearing (the envelope reveal spends it by
    // vout, the decoder reads the chunk legs in order), so it has to stay put.
    // The PSBT is unsigned at this point and every serialization path reads the
    // same unsigned transaction object, so the write is seen by psbt.txOutputs,
    // psbt.toHex() and the reveal builder alike. Asserted rather than assumed:
    // a bitcoinjs release that reshapes this would otherwise underfund a reveal
    // silently, which is the exact failure this whole pass exists to prevent.
    raiseOutputValue(psbt, outputIndex, delta){
        if (!Number.isInteger(delta) || delta <= 0){
            throw new RangeError('output uplift must be a positive integer')
        }
        const outs = psbt.data.globalMap.unsignedTx
            && psbt.data.globalMap.unsignedTx.tx
            && psbt.data.globalMap.unsignedTx.tx.outs
        if (!Array.isArray(outs) || !outs[outputIndex]){
            throw new RangeError(`no output at index ${outputIndex} to raise`)
        }
        const raised = outs[outputIndex].value + delta
        outs[outputIndex].value = raised
        if (psbt.txOutputs[outputIndex].value !== raised){
            throw new RangeError('output value uplift did not reach the transaction bitcoinjs will serialize')
        }
    },

    estimateSpendingP2shTx(redeemData){
        // Per-chunk embedded value sized to cover the spending tx's worst
        // case at 1 sat/vbyte. Includes tx overhead, the OP_RETURN marker
        // output, the P2SH input bringing this chunk's redeem script (sig +
        // compressed pubkey + redeem script push; see estimateP2shInputWithRedeem),
        // plus a small safety margin to absorb DER signature length jitter so the
        // broadcast never lands fractionally under the node's min relay fee floor.
        let sizeEstimated =
            10 // 4 version + 1 inputs count + 1 outputs count + 4 locktime
            + TxSizeEstimator.estimateP2shInputWithRedeem(redeemData)
            + TxSizeEstimator.estimateOpReturnOutput(Buffer.concat([
                Buffer.from(MAGIC_WORD,'utf8'),
                Buffer.from("p2sh",'utf8')
            ]))
            + 8 // safety margin for DER-sig length jitter (sig push assumes 72B)

        return sizeEstimated
    },

    // Whole-tx size of the P2SH reveal (phase 2): every chunk input carrying its
    // redeem script, the OP_RETURN marker output, plus extraOutputsBytes for the
    // value outputs the reveal emits (the change sweep, reveal-side
    // customOutputs). estimateSpendingP2shTx above is the PER-CHUNK share that
    // sizes each funding leg; this is the fee base for the ONE transaction
    // that spends all of them, so the funding side can top the first leg up to
    // what the reveal will actually need. Both phases MUST
    // price the reveal with this function: the reveal path's generic
    // TxSizeEstimator.estimateInputSize() models a P2SH input as 2-of-3
    // multisig (289 bytes flat) and disagrees with the funding side's
    // redeem-aware estimate, and that drift is exactly what would leave the
    // funded change headroom a few satoshis short of emittable. The per-input
    // +8 is the same DER-signature-length-jitter margin estimateSpendingP2shTx
    // carries.
    estimateP2shRevealTx(dataBufferArray, extraOutputsBytes = 0){
        let inputsBytes = 0
        for (const redeemData of dataBufferArray){
            inputsBytes = inputsBytes + TxSizeEstimator.estimateP2shInputWithRedeem(redeemData) + 8
        }
        return 10 // 4 version + 1 inputs count + 1 outputs count + 4 locktime
            + inputsBytes
            + TxSizeEstimator.estimateOpReturnOutput(Buffer.concat([
                Buffer.from(MAGIC_WORD,'utf8'),
                Buffer.from("p2sh",'utf8')
            ]))
            + extraOutputsBytes
    },

    estimateSpendingP2wshTx(witnessData){
        // Per-chunk embedded value sized to cover the P2WSH reveal tx's worst
        // case at 1 sat/vbyte. A native-segwit input keeps its scriptSig empty
        // and carries the reveal payload (sig + compressed pubkey + witness
        // script) in the witness, which is weight-1 (i.e. ÷4 toward vbytes).
        // That makes a P2WSH reveal materially cheaper than the equivalent P2SH
        // reveal: sizing it with estimateSpendingP2shTx would over-fund ~4x.
        // compactSize, not compiledPushSize: a witness stack item is length-
        // prefixed by a varint on the wire, it is not a push inside a script.
        // The two disagree in two bands and the old script-push model was wrong
        // in both: 76..252 it over-funded by a byte, and 253..255 it UNDER-funded
        // by a byte (OP_PUSHDATA1 is 2 bytes there, the varint is 3).
        let witnessScriptPrefix = compactSizeLen(witnessData.length)
        // Witness stack (weight 1): item count + sig item (1+72) + pubkey item
        // (1+33) + witness-script item prefix + script bytes, plus the segwit
        // marker+flag (2) which are also weight 1. The 72- and 33-byte items are
        // both under 253, so their compactSize prefix is the literal 1 below.
        let witnessBytes = 2                                    // marker + flag
            + 1                                                 // witness stack item count
            + (1 + 72)                                          // sig item
            + (1 + 33)                                          // compressed pubkey item
            + (witnessScriptPrefix + witnessData.length)        // witness script prefix + bytes

        // Non-witness (weight 4) bytes: tx overhead + the empty-scriptSig input
        // outpoint + the OP_RETURN marker output.
        let nonWitnessBytes =
            10 // 4 version + 1 inputs count + 1 outputs count + 4 locktime
            + (36 + 1 + 4) // outpoint(36) + empty scriptSig len(1) + sequence(4)
            + TxSizeEstimator.estimateOpReturnOutput(Buffer.concat([
                Buffer.from(MAGIC_WORD,'utf8'),
                Buffer.from("p2wsh",'utf8')
            ]))

        // A single-chunk reveal's stripped size (71 B) is below Litecoin's
        // tx-size-small floor, so the reveal builder pads it up to the chain's
        // minStandardTxNonWitnessSize with one extra output. Reflect that padded
        // stripped size here so the fee estimate covers the larger reveal. (In
        // normal fee regimes the dust floor dominates the embedded value, but
        // this keeps the estimate honest on high-fee chains.)
        let strippedFloor = this.network.minStandardTxNonWitnessSize
        if (strippedFloor && nonWitnessBytes < strippedFloor){
            nonWitnessBytes = strippedFloor
        }

        // vsize = ceil(total weight / 4) = nonWitnessBytes + ceil(witnessBytes/4)
        let sizeEstimated = nonWitnessBytes
            + Math.ceil(witnessBytes / 4)
            + 8 // safety margin for DER-sig length jitter (sig push assumes 72B)

        return sizeEstimated
    },
}
