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
 * XChain Encoder - Transaction Size Estimator Class
 * 
 * This file handles getting transaction size estimates
 * 
 ********************************************************************/

// Load required libraries
const bitcoin = require('bitcoinjs-lib');
const { compiledPushSize } = require('./validator');

// Byte width of the compactSize varint that length-prefixes a witness-stack
// item on the wire. NOT compiledPushSize: that models script-push framing,
// which switches width at 76/256; the varint switches at 253/65536. The
// envelope tapscript is a witness item and can exceed 65,535 bytes, hence the
// 5-byte band (which compiledPushSize does not even have).
function compactSizeLen(n) {
    if (n < 253) return 1
    if (n <= 0xffff) return 3
    if (n <= 0xffffffff) return 5
    return 9
}

class TxSizeEstimator {
    // OP_RETURN output = 8 (value) + script-length compactSize + scriptPubKey,
    // where scriptPubKey = OP_RETURN (1) + the compiled data push. Push framing
    // comes from the canonical compiledPushSize (direct opcode <=75, OP_PUSHDATA1
    // adds a length byte at 76..255); hardcoding a 1-byte prefix undercounted the
    // 76..80-byte payloads this call site actually reaches, and that estimate
    // prices the fee and the UTXO-sufficiency check.
    static estimateOpReturnOutput(data){
        const scriptLength = 1 + compiledPushSize(data.length)
        return 8 + compactSizeLen(scriptLength) + scriptLength
    }
    
    static estimateP2shOutput(){
        return 32 //8 for value, 1 for scriptpubkey size, 23 for scriptpubkey (1 OP_HASH160, 1 push data, 20 data, 1 OP_EQUAL) 
    }
    
    static estimateP2wshOutput(){
        return 43 //8 for value, 1 for scriptpubkey size, 34 for scriptpubkey (1 OP_0, 1 push data, 32 data)
    }
    
    // Serialized byte cost of a payment output to `address`: 8 (value) +
    // script-length varint + scriptPubKey. Used to fund the reveal (phase-2)
    // transaction's miner fee for the customOutputs it has to carry :
    // the funding tx knows those outputs' VALUE but must also pay for their
    // BYTES, which nothing accounted for before.
    static estimateOutputSizeForAddress(address, network){
        const LARGEST_STANDARD_OUTPUT = 43 // P2WSH/P2TR: 8 + 1 + 34
        if (!address) return LARGEST_STANDARD_OUTPUT
        let script
        try {
            script = bitcoin.address.toOutputScript(address, network)
        } catch (e) {
            // Unparseable here (foreign prefix, custom network table): assume the
            // largest standard output rather than under-funding the reveal. The
            // address is validated for real when the reveal adds the output.
            return LARGEST_STANDARD_OUTPUT
        }
        return 8 + (script.length < 0xfd ? 1 : 3) + script.length
    }

    // P2TR commit output for the Taproot envelope : 8 (value) + 1
    // (script-length varint) + 34 (OP_1 + push + 32-byte tweaked key) = 43.
    // Same bytes as a P2WSH output; separate method so envelope call sites
    // read as what they are and can diverge if either shape ever does.
    static estimateTaprootOutput(){
        return 43
    }

    // Virtual size of an envelope reveal transaction ( spec §3.9): one
    // script-path P2TR input carrying the envelope tapscript, plus
    // `outputsBytes` of serialized outputs (change, and the LTC stripped-floor
    // pad when present). Witness bytes (weight 1, ÷4 toward vsize):
    //   marker+flag (2) + stack item count (1)
    //   + signature item (1 + 65: worst case, a 64-byte Schnorr sig plus an
    //     explicit sighash byte; SIGHASH_DEFAULT signs as 64 and costs less)
    //   + envelope script item (compactSize prefix + script bytes)
    //   + control block item (1 + 33: single-leaf tree, no merkle path)
    // Non-witness (weight 4) bytes: 10 tx overhead + 41 per input (36-byte
    // outpoint + 1-byte empty scriptSig length + 4-byte sequence) + outputs.
    // `strippedFloor` mirrors estimateSpendingP2wshTx: chains with a
    // minStandardTxNonWitnessSize relay floor (LTC 85) measure the reveal's
    // stripped size against it, and the reveal builder pads up to the floor,
    // so the estimate must charge for the padded size.
    static estimateEnvelopeRevealTx(envelopeScriptLength, outputsBytes, strippedFloor){
        const witnessBytes = 2 + 1
            + (1 + 65)
            + (compactSizeLen(envelopeScriptLength) + envelopeScriptLength)
            + (1 + 33)
        let nonWitnessBytes = 10 + (36 + 1 + 4) + outputsBytes
        if (strippedFloor && nonWitnessBytes < strippedFloor){
            nonWitnessBytes = strippedFloor
        }
        // + 2: estimate slack so the funded value never lands a satoshi short
        // of the relay floor (Schnorr sigs have no DER length jitter, so this
        // is margin for the vsize ceiling rounding, not signature variance).
        return nonWitnessBytes + Math.ceil(witnessBytes / 4) + 2
    }

    static estimateMultisignOutput(){
        // 8 (value) + 1 (script-length varint) + 105 (script) = 114.
        // The 1-of-3 compressed bare-multisig script is 105 bytes:
        //   OP_1 (1) + 3x(1 push opcode + 33 pubkey) (102) + OP_3 (1) + OP_CHECKMULTISIG (1).
        // The prior 102-byte figure omitted the three push opcodes (undercount by 3).
        return 114
    }
    
    static estimateP2shInputWithRedeem(redeemData){
        // Outpoint (32 txid + 4 vout) + sequence (4) = 40 bytes
        // ScriptSig length varint: 1 byte for ScriptSig <253 bytes, 3 bytes for 253..65535
        // ScriptSig contents (the XChain reveal finalizer pushes sig, pubkey, then
        // the redeem script (see xchain-e2e-test xchainP2shFinalizer):
        //   - sig push:    1-byte opcode + 72 bytes (sig + sighash)
        //   - pubkey push: 1-byte opcode + 33 bytes (compressed pubkey)
        //   - redeem script push: 1 byte for <76, 2 bytes (OP_PUSHDATA1) for 76..255,
        //                         3 bytes (OP_PUSHDATA2) for 256..65535
        //   - redeem script bytes
        let sigPush      = 1 + 72                                   // 73
        let pubkeyPush   = 1 + 33                                   // 34
        let redeemPush   = compiledPushSize(redeemData.length) - redeemData.length
        let scriptSig    = sigPush + pubkeyPush + redeemPush + redeemData.length
        let scriptVarint = scriptSig < 253 ? 1 : 3
        return 40 + scriptVarint + scriptSig
    }
    
    // Estimates the final vSize of a UTXO
    // The utxo should have the structure {hash, index, sequence, (witnessUtxo or nonWitnessUtxo)}.
    static estimateInputSize(utxo) {
        // 1. Obtaining the scriptPubKey
        let scriptPubKey
        let isSegwit = false

        if (utxo.witnessUtxo) {
            scriptPubKey = utxo.witnessUtxo.script
            isSegwit = true
        } else if (utxo.nonWitnessUtxo) {
            try {
                const tx = bitcoin.Transaction.fromBuffer(utxo.nonWitnessUtxo)
                const output = tx.outs[utxo.index]
                if (output) {
                    scriptPubKey = output.script
                }
            } catch (e) {
                console.error("Error decoding nonWitnessUtxo:", e)
                return 350
            }

            if (!scriptPubKey) {
                console.log("It was not possible to obtain the scriptPubKey. Assuming P2PKH.");
                return 180;
            }
        } else {
            //The utxo doesn't have witnessUtxo nor nonWitnessUtxo
            //Return conservative fallback to avoid silent fee underestimation
            return 350
        }

        // Convert to hex string to detect patterns
        const scriptHex = scriptPubKey.toString('hex')

        // 2. Classification and Estimation for Native SegWit
        if (isSegwit) {
            if (scriptHex.startsWith('0014')) {
                // P2WPKH: 0014{20-byte hash}
                return 68
            }
            if (scriptHex.startsWith('0020')) {
                // P2WSH: 0020{32-byte hash} - Assuming 2-3 Multisig
                return 105
            }
            if (scriptHex.startsWith('5120')) {
                // P2TR: 5120{32-byte x-only key}. Key-path spend = 1 Schnorr
                // witness (~57.5 vbytes incl. prevout + sequence). Without this it
                // fell through to the 350 fallback and wildly over-estimated fees.
                return 58
            }
        }

        // 3. Classification and Estimation for Legacy
        
        // P2PKH (Legacy): 76a914{20-byte hash}88ac
        if (scriptHex.startsWith('76a914') && scriptHex.endsWith('88ac')) {
            return 180
        }

        // P2SH (Legacy): a914{20-byte hash}87
        if (scriptHex.startsWith('a914') && scriptHex.endsWith('87')) {
            // **Conservative Estimate for P2SH:**
            // Assuming 2-3 Legacy Multisig (The most expensive option, ~289 bytes).
            // If the input is a nested P2SH-P2WPKH, the transaction will be like segwit
            // and this path cannot be taken, so if it gets here and it's a P2SH, most probably is it's Legacy.
            return 289 
        }
        
        // 4. Fallback
        return 350
    }
}

module.exports = TxSizeEstimator