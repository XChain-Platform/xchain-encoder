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

const { Encoding } = require('../constants.js')

// The duplicate-build gate, then the response object and its additive fields.
function finishBuild(build){
    let { callReservations, psbt, preparedData } = build
    // Carrier scripts for the chunk lanes, so a client can VERIFY the
    // commit outputs it is about to sign instead of trusting them.
    //
    // An inline OP_RETURN action can be read straight back out of the PSBT
    // and cross-checked against what the caller asked for. A P2SH/P2WSH
    // action cannot: the payload lives in a redeem script that only exists
    // here, and the commit output is just its hash, so the client had no
    // way to tell a faithful encoding from a substituted one. That residual
    // trust is what this closes.
    //
    // These are the SAME compiled buffers that became the outputs above
    // (dataBufferArray IS the redeem-script array for these encodings), not
    // a re-derivation, so they cannot drift from what was actually built.
    // Publishing them reveals nothing secret: the script is disclosed on
    // chain the moment the reveal tx spends the output.
    //
    // The client's two checks are then: hash each script to a P2SH/P2WSH
    // output and require a match in the PSBT, and require the leading data
    // pushes to concatenate to the action it intended. Passing a forged
    // script means failing one or the other.

    // Last gate before the transaction leaves: an identical unsigned tx built
    // inside the reservation window is refused, not returned as a new success.
    // Every path through _buildTransaction reaches it, the P2SH/P2WSH reveal
    // included (an identical reveal is a duplicate too), and the TAPROOT reveal
    // is derived from this commit, so guarding the commit guards the pair.
    // createEnvelopeCancelTransaction is the one build path outside
    // _buildTransaction; it takes its own outpoint reservation instead, and
    // states there why duplicate refusal must not apply to it.
    // The txid rides back on the per-call reservation ledger so the ticket
    // minted for this build can retire this record too (see releaseReservation).
    callReservations.buildTxid = this.refuseDuplicateBuild(psbt, Date.now())

    let result = {"psbt":psbt,"encoding":preparedData["encoding"]}

    attachAdvisories(build, result)
    attachCompression(build, result)
    attachCarriers(build, result)
    return result
}

function attachAdvisories(build, result){
    let { rawDataOnlyPayload, unknownAction } = build
    // Non-fatal advisory for the fee-payer; see rawDataOnlyPayload above. Additive
    // result field, the same shape `compression` already established, so a caller
    // that does not read it is unaffected.
    if (rawDataOnlyPayload){
        result.warnings = [{
            code: 'RAWDATA_ONLY_NOT_DECODED',
            message: 'rawData without data compiles to an OP_0-led payload that current ' +
                'XChain decoders read as empty: the transaction will confirm and the fee ' +
                'will be paid, but the payload will not be indexed as an ACTION'
        }]
    }

    // The library path's ACTION-name advisory; see unknownAction above. Same
    // additive `warnings` field, appended rather than assigned so it can ride
    // alongside the rawData-only advisory when a caller earns both.
    if (unknownAction != null){
        if (!result.warnings) result.warnings = []
        result.warnings.push({
            code: 'UNKNOWN_ACTION_NAME',
            message: `data leads with '${String(unknownAction).slice(0, 32)}', which is ` +
                'neither a canonical XChain ACTION name nor a known alias: the transaction ' +
                'will confirm and the fee will be paid, but every decoder drops the payload ' +
                'instead of indexing it as an ACTION. The JSON-RPC create_tx surface refuses ' +
                'this payload outright'
        })
    }
}

function attachCompression(build, result){
    let { compressionResult } = build
    // What compression actually did, reported rather than inferred. The
    // wallet has to show the REAL on-chain size, and with the
    // default ON a caller can no longer assume from its own request whether
    // the bytes were compressed: `reason` names why they were not.
    if (compressionResult){
        result.compression = {
            compressed:   compressionResult.compressed,
            rawLength:    compressionResult.rawLength,
            storedLength: compressionResult.storedLength,
            reason:       compressionResult.reason
        }
        // THE BYTES, not just the verdict. A boolean plus two lengths is not
        // enough to rebuild this transaction: the compression pass rewrote the
        // COMPRESSION field and replaced the payload in place, so a caller
        // holding only its own pre-compression request can neither state what
        // these bytes say (its confirm check reads a string the PSBT does not
        // carry, and refuses its own transaction as tampered) nor rebuild the
        // phase-2 reveal from them (re-deriving the marker without the deflated
        // payload compiles a DIFFERENT carrier, and a reveal that does not
        // reproduce the commit's chunks can never spend the commit - the funds
        // are stranded, after the money is spent).
        //
        // So both halves ride back exactly as they went in: `data` is the action
        // string written into the carrier, and `rawData` the stored payload in
        // the same Latin-1 one-char-per-byte form every rawData parameter takes,
        // so it can be handed straight back to create_tx/spendP2sh. Present only
        // when compression actually fired; an untouched payload is already the
        // caller's own.
        if (compressionResult.compressed){
            result.compression.data    = compressionResult.data
            result.compression.rawData = compressionResult.rawData.toString('binary')
        }
    }
}

function attachCarriers(build, result){
    let { preparedData, revealPsbt, envelopeResult } = build
    if (preparedData["encoding"] === Encoding.P2SH || preparedData["encoding"] === Encoding.P2WSH){
        result.carrierScripts = (preparedData["dataBufferArray"] || []).map(b => b.toString('hex'))
    }
    if (revealPsbt){
        // Two-tx response shape: the caller signs both,
        // then broadcasts commit followed by reveal. carrierScripts serves
        // the same verify-before-sign contract as the chunk lanes: hash the
        // script to the P2TR commit output and require a match, and require
        // the payload pushes to concatenate to the intended action.
        // `envelope` carries what the wallet must DURABLY PERSIST BEFORE
        // BROADCASTING the commit (plus its own internal-key derivation
        // path): lose the tapleaf hash and the key-path cancel tweak cannot
        // be reconstructed, stranding the funds.
        result.revealPsbt = revealPsbt
        result.carrierScripts = (preparedData["dataBufferArray"] || []).map(b => b.toString('hex'))
        result.envelope = envelopeResult
    }
}

module.exports = { finishBuild }
