/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
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

class TxSizeEstimator {
    static estimateOpReturnOutput(data){
        //TODO: this won't be precise if the scriptpubkey is greater than 252 bytes
        return 11 +//8 for value, 1 for OP_RETURN, 1 for script pubkey size flag, 1 for push data
             data.length
    }
    
    static estimateP2shOutput(){
        return 32 //8 for value, 1 for scriptpubkey size, 23 for scriptpubkey (1 OP_HASH160, 1 push data, 20 data, 1 OP_EQUAL) 
    }
    
    static estimateP2wshOutput(){
        return 43 //8 for value, 1 for scriptpubkey size, 34 for scriptpubkey (1 OP_0, 1 push data, 32 data)
    }
    
    static estimateMultisignOutput(){
        return 111 //8 value, 1 scriptpubkey size, 102 script pub key (1 M, 33 pubkey1, 33 pubkey2, 33 pubkey3, 1 N, 1 CHECKMULTISIG) 
    }
    
    static estimateP2shInputWithRedeem(redeemData){
        // Outpoint (32 txid + 4 vout) + sequence (4) = 40 bytes
        // ScriptSig length varint: 1 byte for ScriptSig <253 bytes, 3 bytes for 253..65535
        // ScriptSig contents:
        //   - sig push: 1-byte opcode + 72 bytes (sig + sighash)
        //   - redeem script push: 1 byte for <76, 2 bytes (OP_PUSHDATA1) for 76..255,
        //                         3 bytes (OP_PUSHDATA2) for 256..65535
        //   - redeem script bytes
        let sigPush      = 1 + 72                                   // 73
        let redeemPush   = redeemData.length < 76   ? 1
                         : redeemData.length < 256  ? 2
                         :                            3
        let scriptSig    = sigPush + redeemPush + redeemData.length
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
                console.error("Error decoding nonWitnessUtxo:", e.message)
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