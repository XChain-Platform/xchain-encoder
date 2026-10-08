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
const crypto = require('crypto');
const util = require('node:util');
const TxSizeEstimator = require('../build/tx_size_estimator')
const { parseSatoshiAmount, validateFeePerKb, validateOptionalBoolean, validateOutpoint, assertPubkeyOnCurve } = require('../common/validator')
const { OperationalError, ParamTypeError, ParamRangeError } = require('../build/errors')
const { logger, SATOSHI_UNIT, RESERVATION_TTL_MS, Encoding } = require('./constants.js')
const { ensureEccLib } = require('./script_amount_helpers.js')
const { assertAddressOnNetwork } = require('./request_resolution.js')
const { capCallerFeeRate, clampLimitLabel, feeForVsize } = require('./fee_policy.js')

// The cancel's recovery record as handed over: validated, decoded, and read
// into the values the build uses.
function readCancelRecord(commitTxid, commitVout, commitValue, internalPubkey, tapleafHash, destination, feePerKb, replacebyfee){
    // Check the outpoint by create_tx's rule, so both paths build one canonical reservation key.
    const outpoint = validateOutpoint(commitTxid, commitVout, 'commitTxid', 'commitVout')
    const value = parseSatoshiAmount(commitValue, 'commitValue')
    // Accept the 33-byte compressed form (what create_tx took) or the
    // 32-byte x-only form (what the recovery record may hold).
    let internalKeyBuf
    if (typeof internalPubkey === 'string' && /^(02|03)[0-9a-fA-F]{64}$/.test(internalPubkey)) {
        internalKeyBuf = Buffer.from(internalPubkey, 'hex').subarray(1)
    } else if (typeof internalPubkey === 'string' && /^[0-9a-fA-F]{64}$/.test(internalPubkey)) {
        internalKeyBuf = Buffer.from(internalPubkey, 'hex')
    } else {
        throw new ParamTypeError('internalPubkey must be a 66-character compressed or 64-character x-only pubkey hex string')
    }
    // Refuse an off-curve key here as -32602, before any claim or fee RPC.
    assertPubkeyOnCurve(internalKeyBuf, 'internalPubkey')
    if (typeof tapleafHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(tapleafHash)) {
        throw new ParamTypeError('tapleafHash must be a 64-character hex string')
    }
    // validateAddress, not a local non-empty check: this is the one create
    // path api.js does not route through validateAll, so without it the
    // 100-char cap every other address field gets is missing here and an
    // unbounded string reaches bs58check (quadratic) and psbt.addOutput.
    // assertAddressOnNetwork runs that shape check first, then refuses an
    // address that does not decode on this network, before any claim or fee RPC.
    assertAddressOnNetwork(destination, this.network, 'destination')
    if (this.network.supportsSegwit === false) {
        throw new ParamTypeError('TAPROOT encoding is not supported on this network (no segwit support)')
    }
    // Same money/boolean guards create_tx gets through validateAll, so both
    // create paths classify identical bad input identically (-32602). Left
    // uncoerced, a non-numeric feePerKb becomes NaN, slips past both dust
    // comparisons (every NaN comparison is false) and surfaces as an opaque
    // -32603; and the JSON string "false" is truthy, silently arming RBF.
    const feeRatePerKb = validateFeePerKb(feePerKb)
    const rbfArmed     = validateOptionalBoolean(replacebyfee, 'replacebyfee') === true
    ensureEccLib()
    const tapleafHashBuf = Buffer.from(tapleafHash, 'hex')
    return { outpoint, value, internalKeyBuf, feeRatePerKb, rbfArmed, tapleafHashBuf }
}

function claimCommitOutpoint(callReservations, commitTxid, commitVout){
    // Cross-path double-spend guard. This is the one build path outside
    // _buildTransaction, so without a claim here a concurrent create_tx whose
    // fetched set still carries the commit output selects and reserves it while
    // an unsigned cancel of that same output is outstanding. Lowercased (again,
    // after validateOutpoint already canonicalized it) because create_tx keys are
    // canonicalized in validator.validateUtxoEntry, and an uppercase key can
    // never collide with the reservation it is meant to see. Claimed
    // synchronously, before the first await below, so a concurrent call
    // observes it.
    const outpointKey = commitTxid.toLowerCase() + ':' + commitVout
    const nowClaim = Date.now()
    this.evictExpiredReservations(nowClaim)
    this.evictExpiredEnvelopeCancelClaims(nowClaim)
    // Reserved AND not held by this path: the reservation is worth the highest
    // live cancel-owner expiry whenever a cancel build holds it, so any other
    // value means a foreign createTransaction claim owns the outpoint.
    if (this.isOutpointReserved(outpointKey, nowClaim) &&
        this.maxLiveCancelOwnerExpiry(outpointKey, nowClaim) !== this.outpointReservations.get(outpointKey)){
        throw new OperationalError(
            'ENVELOPE_CANCEL_OUTPOINT_RESERVED',
            `commit outpoint ${outpointKey} is reserved by a transaction built in the last ` +
                `${Math.round(RESERVATION_TTL_MS / 60000)} minutes; broadcast that transaction and rebuild ` +
                'from the resulting view, or wait for the reservation to lapse',
            { outpoint: outpointKey }
        )
    }
    // Re-taking this path's OWN live claim is allowed, and refuseDuplicateBuild
    // is deliberately not wired in here, for the same reason: the header
    // contract above is that a cancel rebuilds from the persisted recovery
    // record alone, so a lost-response retry must not be refused for five
    // minutes for producing the byte-identical transaction it is supposed to.
    //
    // Each build registers its own owner token rather than overwriting a single
    // stamp, so an overlapping build's failure releases only what it took. A
    // single stamp, overwritten and then deleted, hands the commit outpoint back
    // to createTransaction while the first build's unsigned cancel still spends it.
    this.claimOutpoint(callReservations, outpointKey, nowClaim)
    const cancelClaim = callReservations[callReservations.length - 1]
    const cancelOwnerId = crypto.randomBytes(16).toString('hex')
    cancelClaim.cancelOwnerId = cancelOwnerId
    let cancelOwners = this.envelopeCancelClaims.get(outpointKey)
    if (!cancelOwners) {
        cancelOwners = new Map()
        this.envelopeCancelClaims.set(outpointKey, cancelOwners)
    }
    cancelOwners.set(cancelOwnerId, cancelClaim.expiry)
}

// A generator rather than an async function: it hands each node fee-rate
// promise to the driver loop in buildEnvelopeCancelTransaction, so the cancel
// suspends once per wait, exactly where the inline code it came from did.
// Awaited as an async function it would add one more suspension after the
// commit-outpoint claim.
function* cancelFeeRate(feeRatePerKb){
    // Clamp the caller rate through the same capCallerFeeRate createTransaction
    // uses: a cancel sweeps a prefund that scales with payload size and fee
    // rate, so an unbounded rate here sends the whole commit to the miner.
    const info = yield this.connector.getNetworkInfo()
    const relayFeePerKb = Number(info && info.relayfee)
    // Refuse a node that reports no usable relay floor. A plain Error, not a
    // RangeError: this is the node's fault, so the API answers retryable -32603.
    if (!Number.isFinite(relayFeePerKb) || relayFeePerKb <= 0){
        throw new Error('Node did not report a positive relayfee; transaction fee safety cannot be verified')
    }
    let feePerBytes
    let nodeFeePerBytes = null
    if (feeRatePerKb){
        feePerBytes = feeRatePerKb / 1000 / SATOSHI_UNIT
        try {
            nodeFeePerBytes = (yield this.connector.getFeePerKilobyte(1)) / 1000
        } catch (err) {
            logger.warn(util.format('Envelope-cancel fee cap anchored on relayfee: node fee estimate unavailable:', err.message))
        }
    } else {
        feePerBytes = (yield this.connector.getFeePerKilobyte(1)) / 1000
        nodeFeePerBytes = feePerBytes
    }
    const capped = capCallerFeeRate({ feePerBytes, nodeFeePerBytes, relayFeePerKb,
        maxFeePerBytes: this.maxFeePerBytes, maxFeeRateMultiplier: this.maxFeeRateMultiplier })
    if (capped.clamped){
        const limit = clampLimitLabel(capped)
        logger.warn(`Envelope-cancel fee rate ${feePerBytes * 1000 * SATOSHI_UNIT} sat/kB exceeds ${limit}, clamping to ${capped.feePerBytes * 1000 * SATOSHI_UNIT} sat/kB`)
    }
    return { feePerBytes: capped.feePerBytes, relayFeePerKb }
}

// The cancel's fee at the chain's stripped-size floor, and the sweep that remains.
function sizeCancelSweep(destination, value, feePerBytes, relayFeePerKb, callerFeePerKb){
    // vsize: 10 tx overhead + 58 key-path input (41 stripped + witness) +
    // destination output + 2 rounding slack; padded to the chain's
    // stripped-size relay floor exactly like the reveal (the key-path
    // witness does not count toward stripped size either).
    const destOutBytes = TxSizeEstimator.estimateOutputSizeForAddress(destination, this.network)
    const cancelStrippedFloor = this.network.minStandardTxNonWitnessSize
    const padNeeded = !!(cancelStrippedFloor && (10 + 41 + destOutBytes) < cancelStrippedFloor)
    let strippedBytes = 10 + 41 + destOutBytes + (padNeeded ? destOutBytes : 0)
    if (cancelStrippedFloor && strippedBytes < cancelStrippedFloor){
        strippedBytes = cancelStrippedFloor
    }
    const cancelVsize = strippedBytes + Math.ceil((2 + 1 + 1 + 65) / 4) + 2
    let cancelFee = feeForVsize(cancelVsize, feePerBytes, SATOSHI_UNIT)
    if (callerFeePerKb != null){
        const relayFeeBaseUnitsPerKb = Math.round(relayFeePerKb * SATOSHI_UNIT)
        const minimumRelayFee = Math.ceil(cancelVsize * relayFeeBaseUnitsPerKb / 1000)
        if (cancelFee < minimumRelayFee){
            throw new ParamRangeError(`feePerKb ${callerFeePerKb} base units/kB produces fee ${cancelFee}, below the node relay minimum ${minimumRelayFee} base units for a ~${cancelVsize}-byte transaction`)
        }
    }
    if (cancelFee < this.dustAmount){
        cancelFee = this.dustAmount
    }

    const sweepValue = value - cancelFee - (padNeeded ? this.dustAmount : 0)
    if (sweepValue < this.dustAmount){
        throw new OperationalError(
            'ENVELOPE_CANCEL_BELOW_DUST',
            `cancel would sweep ${sweepValue} satoshis (commit value ${value} minus fee ${cancelFee}${padNeeded ? ' minus floor pad' : ''}), below the dust floor (${this.dustAmount}); spend it via the reveal or CPFP instead`,
            { commitValue: value, fee: cancelFee, sweepValue }
        )
    }
    return { padNeeded, cancelFee, sweepValue }
}

module.exports = {
    // Key-path cancel of an UNREVEALED envelope commit:
    // sweeps the commit output back to the caller before any reveal exists. By
    // contract this must be buildable from the wallet's PERSISTED RECOVERY
    // RECORD ALONE ({commit outpoint, internal key derivation path, tapleaf
    // hash} plus the commit value), surviving a crash between commit and
    // reveal: nothing here re-derives from the envelope payload, and the P2TR
    // scriptPubKey is reconstructed from internal key + merkle root (the
    // tapleaf hash IS the merkle root of the single-leaf tree). The returned
    // PSBT carries tapInternalKey + tapMerkleRoot so the signer can compute
    // the BIP341 tweak; it conflicts with the reveal by construction (same
    // outpoint) and the wallet treats it as a replacement of the reveal.
    //
    // Public entry point. Like createTransaction it owns the per-call reservation
    // ledger: a build that throws for any reason hands the commit outpoint back at
    // once instead of squatting it until RESERVATION_TTL_MS.
    // A successful cancel keeps its commit-outpoint claim and gets the same
    // `reservation` receipt create_tx does, so an abandoned cancel can hand the
    // commit outpoint back instead of blocking every rebuild for the whole TTL.
    async createEnvelopeCancelTransaction(params = {}){
        const callReservations = []
        let result
        try {
            result = await this.buildEnvelopeCancelTransaction(callReservations, params)
        } catch (err) {
            this.releaseEnvelopeCancelClaims(callReservations)
            throw err
        }
        const reservation = this.mintReservationTicket(callReservations, Date.now())
        if (reservation && result && typeof result === 'object') result.reservation = reservation
        return result
    },

    async buildEnvelopeCancelTransaction(callReservations, { commitTxid, commitVout, commitValue, internalPubkey, tapleafHash, destination, feePerKb = null, replacebyfee = false } = {}){
        const { outpoint, value, internalKeyBuf, feeRatePerKb, rbfArmed, tapleafHashBuf } = readCancelRecord.call(this,
            commitTxid, commitVout, commitValue, internalPubkey, tapleafHash, destination, feePerKb, replacebyfee)

        claimCommitOutpoint.call(this, callReservations, outpoint.txid, outpoint.vout)

        // Drive the fee-rate generator inline: each promise it yields is awaited
        // here once, and a rejection goes back in so its own try/catch sees it.
        const feeRate = cancelFeeRate.call(this, feeRatePerKb)
        let next = feeRate.next()
        while (!next.done){
            let settled
            try {
                settled = await next.value
            } catch (err) {
                next = feeRate.throw(err)
                continue
            }
            next = feeRate.next(settled)
        }
        const { feePerBytes, relayFeePerKb } = next.value

        const p2trPayment = bitcoin.payments.p2tr({
            internalPubkey: internalKeyBuf,
            hash: tapleafHashBuf,
            network: this.network
        })

        const { padNeeded, cancelFee, sweepValue } = sizeCancelSweep.call(
            this, destination, value, feePerBytes, relayFeePerKb, feeRatePerKb)

        const psbt = new bitcoin.Psbt({ network: this.network })
        psbt.addInput({
            hash: outpoint.txid,
            index: outpoint.vout,
            // Same BIP68 trap as the funding path above: 0xfffffffd signals RBF
            // without enabling relative locktime.
            sequence: (rbfArmed ? 0xfffffffd : 0xffffffff),
            witnessUtxo: {
                script: p2trPayment.output,
                value: value
            },
            tapInternalKey: internalKeyBuf,
            tapMerkleRoot: tapleafHashBuf
        })
        psbt.addOutput({ address: destination, value: sweepValue })
        if (padNeeded){
            psbt.addOutput({ address: destination, value: this.dustAmount })
        }

        return { psbt, encoding: Encoding.TAPROOT, cancel: true, fee: cancelFee }
    },
}
