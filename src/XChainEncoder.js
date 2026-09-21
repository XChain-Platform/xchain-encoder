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

// Must load before any PSBT is built: teaches bitcoinjs-lib/bip174 to carry
// satoshi values above 2^53-1 as BigInt (DOGE has no supply cap).
require('./build/apply_bufferutils_patch')
const bitcoin = require('bitcoinjs-lib');
const crypto = require('crypto');
const bs58check = require('bs58check')
// Held as the module object and dereferenced per call, so a test that swaps
// coins.verifyConsensusPin still reaches the constructor's pin check.
const coins = require('./coins')
const BlockchainConnector = require('./build/blockchain_connector')
const CryptoNetworks = require('./build/crypto_networks')
const UtxoTracker = require('./build/utxo_tracker')
const TxSizeEstimator = require("./build/tx_size_estimator")
const { MAX_COMPILED_ACTION_DATA_LENGTH, ENVELOPE_MAX_PAYLOAD, MAX_UTXO_COUNT, validateUtxoEntry, parseSatoshiAmount, validateFeePerKb, validateOptionalBoolean, validateAddress, validateDataParam, validateActionPushDecodability, unknownActionName } = require('./common/validator')
const { compressPayloadForAction } = require('./build/compression')
const { OperationalError } = require('./build/errors')
const { upstreamErrorMessage } = require('./common/error_sanitize')
const util = require('node:util');
const config = require('./common/config');

const { logger, MAGIC_WORD, TAPROOT_LEAF_VERSION, SATOSHI_UNIT, DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE, DEFAULT_MAX_CPFP_UPLIFT_SAT, RESERVATION_TTL_MS, Encoding } = require('./XChainEncoder/constants.js')
const { softDustFloorFor, envelopeTapLeafHash, ensureEccLib, asSatValue, jsonSafeSat } = require('./XChainEncoder/script_amount_helpers.js')
const { isTestNetworkKey, suggestedFeeCeilingPerByte, suggestedFeeCeilingFloorPerByte, maxCpfpUpliftSat, packageFeeUpliftSatoshis } = require('./XChainEncoder/fee_policy.js')
const { classifyTrackerFreshness, resolveCallerAddress, defaultCompressionEnabled, assertRevealFundingTxMatches } = require('./XChainEncoder/request_resolution.js')
const { checkPayloadInput, compressPayload, compilePayload, classifyPayload, chooseEncoding, checkEnvelopeEncoding } = require('./XChainEncoder/build_transaction/payload_checks.js')
const { resolveFeeRates } = require('./XChainEncoder/build_transaction/fee_rates.js')
const { initInputState, checkExactInputs, gatherUtxos, refuseShrunkExactInputs, filterAndOrderUtxos } = require('./XChainEncoder/build_transaction/input_candidates.js')
const { bindObfuscationKey } = require('./XChainEncoder/build_transaction/first_input_key.js')
const { prepareDataChunks, priceRevealCustomOutputs, initEmissionState, emitDataOutputs, emitCustomOutputs } = require('./XChainEncoder/build_transaction/data_outputs.js')
const { initSelection, selectFundingInputs } = require('./XChainEncoder/build_transaction/input_selection.js')
const { refuseExcessiveFee, upliftForAncestors, floorEstimatedFee, prefundRevealPackage, computeChange } = require('./XChainEncoder/build_transaction/fee_settlement.js')
const { emitChangeAndPad, sweepP2shReveal, buildEnvelopeReveal } = require('./XChainEncoder/build_transaction/reveal_outputs.js')
const { finishBuild } = require('./XChainEncoder/build_transaction/build_result.js')


// Default ceiling on any caller-supplied fee, expressed as a multiple of the
// node's own estimatesmartfee(1) estimate. Without a cap, a malicious or buggy
// caller can set fee/feePerKb so high that every selected input is drained
// into miner fee (the user signs the PSBT none the wiser). Relative to the
// node estimate rather than absolute, so it tracks fee-market swings and works
// across chains with very different fee scales (BTC/LTC/DOGE). 100× passes any
// plausible priority/RBF fee (and fixed regtest test fees over quiet-chain
// estimates) while still rejecting drain-grade fees, which sit thousands of
// multiples above the market rate.
const DEFAULT_MAX_FEE_RATE_MULTIPLIER = 100



// Ceiling (in blocks) on how far the utxo-tracker's committed view may lag
// the chain tip before a tracker-fetched UTXO set is refused rather than
// risked (the "stale-utxo trap"). A lagging tracker can
// hand back a UTXO already spent on-chain, or omit one that only just
// confirmed, producing a PSBT the network silently rejects. The tracker's
// own general-purpose readiness signal (SYNCED_THRESHOLD, in
// xchain-utxo-tracker/src/XChainUtxoTracker.js) tolerates 3 blocks of catch-up
// lag; 2 is tighter here on purpose; spending money is a more sensitive
// operation than an average balance/UTXO read, and the tracker is expected to
// trail the tip by a block or two under normal polling cadence, so 2 absorbs
// that without false-positiving on routine operation.
const DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS = 2

// The per-instance double-spend bookkeeping a build consults: outpoint
// reservations, recent builds, envelope-cancel owners and reservation tickets.
function initReservationMaps(){
    // outpoint ("txid:vout") -> reservation-expiry epoch ms. Guards against
    // two create_tx calls for the same address, concurrent or a few hundred
    // milliseconds apart, both selecting the same UTXO and emitting conflicting
    // double-spends. Engaged for EVERY selection, caller-supplied sets
    // included: the SDK fetches the funding set itself and hands it over as
    // `utxos`, so "caller-supplied" is the mainstream wallet path, not a
    // coin-control opt-in. Treating it as unreserved is how three chained
    // MINTs on BTC testnet4 built the same transaction twice.
    // See RESERVATION_TTL_MS.
    this.outpointReservations = new Map()
    // unsigned txid -> expiry epoch ms of every transaction this process built
    // within RESERVATION_TTL_MS. Second line of defense behind the outpoint
    // map: a byte-identical rebuild hashes to the same txid, and returning it
    // as a fresh build let a caller journal one broadcast as two successes.
    this.recentBuilds = new Map()
    // outpoint -> Map(cancel-build owner id -> that build's reservation expiry).
    // A cancel is deterministic from the recovery record, so it must be able to
    // re-take an outpoint its OWN path already holds; an outpoint no cancel
    // owner wrote belongs to another build and blocks it. The owner SET, rather
    // than one expiry stamp, is what makes overlapping cancel builds of a single
    // outpoint distinguishable: the reservation is worth the highest live owner
    // expiry and is dropped only when the last owner lets go, so a failed retry
    // can no longer delete the reservation an earlier outstanding cancel holds.
    // See releaseEnvelopeCancelClaims and maxLiveCancelOwnerExpiry.
    this.envelopeCancelClaims = new Map()
    // reservation ticket id -> the claims ONE successful build kept, with the
    // expiry stamp each of them wrote plus the recent-build record that build
    // registered. This is what makes an explicit release possible without
    // handing callers a way to free somebody else's inputs: the ticket id is
    // unguessable and the per-claim stamp is re-checked at release time, so a
    // caller can only ever drop entries its own build still owns.
    // See releaseReservation.
    this.reservationTickets = new Map()
}




class XChainEncoder {
    constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, utxoTrackerUrl, utxoTrackerPort, maxFeeRateKb=null, maxFeeRateMultiplier=DEFAULT_MAX_FEE_RATE_MULTIPLIER, maxUtxoTrackerLagBlocks=DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS, dustAmount=null) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
      // The raw "<coin>-<net>" key. getBitcoinJsNetwork returns only the
      // bitcoinjs params, which carry no chain identity, and the envelope
      // recognition gate needs to know WHICH chain+network it is building for.
      this.networkKey = network
      // Net portion ('mainnet'|'testnet'|'regtest') of the "<fullname>-<network>"
      // key. getBitcoinJsNetwork above already rejected an unknown key, so the
      // suffix here is a valid network name.
      this.consensusNetwork = String(network).slice(String(network).lastIndexOf('-') + 1)
      // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN before
      // any consensus-relevant field is read, matching decoder, indexer, hub and
      // utxo-tracker. A null pin (pre-arm) skips; a mismatch on an armed network
      // throws, so a drifted or partially re-vendored bundle halts instead of
      // authoring transactions under divergent params (dustThreshold below, and the
      // supportsSegwit / address-prefix rules every output script is built from).
      // Deliberately not wrapped in try/catch, and deliberately in the constructor:
      // api.js builds the singleton encoder at module load, so a later check would
      // let the HTTP surface bind and serve builds first.
      coins.verifyConsensusPin(this.consensusNetwork)
      this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
      this.utxoTrackerConnector = new UtxoTracker(utxoTrackerUrl, utxoTrackerPort)
      // Two floors: dustAmount is the pinned consensus threshold (fee floor, fee-drain
      // caps, burn guard); outputFloor bounds every output this encoder authors and is
      // the same threshold raised to the coin relay floor and again to an operator DUST_AMOUNT.
      this.dustAmount = this.network["dustThreshold"]
      const operatorDust = Number(dustAmount)
      this.outputFloor = Math.max(
          this.dustAmount,
          softDustFloorFor(network),
          (Number.isFinite(operatorDust) && operatorDust > 0) ? Math.floor(operatorDust) : 0
      )
      // Maximum fee rate in BTC/byte (null = no cap). Prevents runaway estimates
      // (e.g. regtest feedback loop) from producing fees that the node will reject.
      // MAX_FEE_RATE_KB is in sat/kB, convert to BTC/byte to match feePerBytes units.
      this.maxFeePerBytes = maxFeeRateKb ? maxFeeRateKb / 1000 / SATOSHI_UNIT : null
      // Relative fee-rate ceiling: caller-supplied fee/feePerKb may not exceed
      // this multiple of the node's current estimate (0/null disables).
      this.maxFeeRateMultiplier = maxFeeRateMultiplier || null
      // See DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS above. `undefined`/`null` from an
      // unset or unparseable env var falls through to the class default via the
      // parameter default above (only a literal `undefined` triggers a JS default
      // parameter, so this normalizes `null` the same way).
      this.maxUtxoTrackerLagBlocks = (maxUtxoTrackerLagBlocks == null) ? DEFAULT_MAX_UTXO_TRACKER_LAG_BLOCKS : maxUtxoTrackerLagBlocks
      initReservationMaps.call(this)
    }


    async _buildTransaction(callReservations, utxos, pubkey, customOutputs, data, rawData, fee, replacebyfee,
      encoding, change, p2shHash=null, p2shHex=null, compressedPubKey=null,
      unconfirmed=true, feePerKb=null, dust=null, feeQuote=null, attachPrevTx=false, compress=null,
      options=null){
        // One state object carries this call's arguments and every value a later
        // step reads. Each step takes what it needs from it and writes back what it
        // set, and the steps run in the order the checks and emissions depend on.
        const build = { callReservations, utxos, pubkey, customOutputs, data, rawData, fee, replacebyfee,
            encoding, change, p2shHash, p2shHex, compressedPubKey,
            unconfirmed, feePerKb, dust, feeQuote, attachPrevTx, compress, options }
        // The steps are generators that yield each node, tracker or payload
        // promise to this loop, so the build suspends only where it waits on a
        // value, once per wait, and runs without a break in between. That is
        // what keeps concurrent builds from interleaving their reservations: a
        // build with nothing to wait on between claiming its first input and
        // finishing selection holds the whole stretch, so a second build over
        // the same address sees every outpoint it took. Awaiting each step as
        // an async function would add a suspension at every step boundary and
        // after every selected input, and two builds would then split one
        // address's outpoints between them and both fail insufficient funds.
        const steps = buildSteps.call(this, build)
        let next = steps.next()
        while (!next.done){
            let settled
            try {
                settled = await next.value
            } catch (err) {
                next = steps.throw(err)
                continue
            }
            next = steps.next(settled)
        }
        return next.value
    }

}

// A P2SH reveal that emits no value output spends every leg satoshi as fee, and
// the signer then refuses it as a full burn. That is a leg funded without
// reveal headroom (a commit from an encoder that predates the headroom top-up).
// The outputless reveal stays byte-identical so the stranded commit can still be
// recovered by a caller that supplies its own outputs; the log names the leg.
function noteUndersizedRevealLeg(build, outputsBeforeSweep){
    const { p2shHash, preparedData, phaseLegInputSatoshis, outputSatoshis, customOutputs, psbt } = build
    if (!p2shHash || preparedData["encoding"] !== Encoding.P2SH || !(phaseLegInputSatoshis > 0n)) return
    if (Array.isArray(customOutputs) && customOutputs.length > 0) return
    if (psbt.txOutputs.length > outputsBeforeSweep) return
    const legSatoshis = phaseLegInputSatoshis - outputSatoshis
    logger.warn(`P2SH_LEG_UNDERSIZED: the phase-1 leg holds ${legSatoshis} base units after the data outputs, too little to pay the reveal fee ` +
        `and leave a change output of at least ${this.outputFloor}. The commit was funded without reveal headroom (an encoder that ` +
        `predates the leg-headroom fix), so this reveal has no value output and the signer will refuse it as a full burn.`)
}

// The build's steps in the order the checks and emissions depend on. A step
// that reads the node, the tracker or a payload promise is a generator
// delegated to with yield*, which adds no suspension of its own; every other
// step runs synchronously inside the same stretch.
function* buildSteps(build){
    checkPayloadInput.call(this, build)
    yield* resolveFeeRates.call(this, build)
    yield* compressPayload.call(this, build)
    compilePayload.call(this, build)
    classifyPayload.call(this, build)
    chooseEncoding.call(this, build)
    yield* checkEnvelopeEncoding.call(this, build)
    initInputState.call(this, build)
    checkExactInputs.call(this, build)
    yield* gatherUtxos.call(this, build)
    refuseShrunkExactInputs.call(this, build)
    filterAndOrderUtxos.call(this, build)
    bindObfuscationKey.call(this, build)
    prepareDataChunks.call(this, build)
    priceRevealCustomOutputs.call(this, build)
    initEmissionState.call(this, build)
    yield* emitDataOutputs.call(this, build)
    emitCustomOutputs.call(this, build)
    initSelection.call(this, build)
    yield* selectFundingInputs.call(this, build)
    refuseExcessiveFee.call(this, build)
    yield* upliftForAncestors.call(this, build)
    floorEstimatedFee.call(this, build)
    prefundRevealPackage.call(this, build)
    computeChange.call(this, build)
    emitChangeAndPad.call(this, build)
    const outputsBeforeSweep = build.psbt.txOutputs.length
    yield* sweepP2shReveal.call(this, build)
    noteUndersizedRevealLeg.call(this, build, outputsBeforeSweep)
    buildEnvelopeReveal.call(this, build)
    return finishBuild.call(this, build)
}

Object.assign(XChainEncoder.prototype, require('./XChainEncoder/outpoint_reservations.js'), require('./XChainEncoder/payload_preparation.js'), require('./XChainEncoder/size_estimation.js'), require('./XChainEncoder/envelope_cancel.js'))


// The suggested-rate ceiling is exported so the estimate_fee endpoint quotes the
// same rate createTx would charge; a quote the builder then ignores is worse than
// no quote, because a wallet shows the user a fee that never applies.
// Present only on an encoder that funds the phase-1 P2SH leg with reveal
// headroom; a venue-health check treats its absence as a stale encoder.
XChainEncoder.P2SH_LEG_HEADROOM = true
XChainEncoder.suggestedFeeCeilingPerByte = suggestedFeeCeilingPerByte
// Exported so api.js's readiness probe classifies a tracker with the exact same
// rules create_tx refuses one with; see classifyTrackerFreshness.
XChainEncoder.classifyTrackerFreshness = classifyTrackerFreshness
XChainEncoder.suggestedFeeCeilingFloorPerByte = suggestedFeeCeilingFloorPerByte
XChainEncoder.isTestNetworkKey = isTestNetworkKey
XChainEncoder.DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE = DEFAULT_SUGGESTED_FEE_MAX_PER_VBYTE
XChainEncoder.packageFeeUpliftSatoshis = packageFeeUpliftSatoshis
XChainEncoder.maxCpfpUpliftSat = maxCpfpUpliftSat
XChainEncoder.DEFAULT_MAX_CPFP_UPLIFT_SAT = DEFAULT_MAX_CPFP_UPLIFT_SAT

module.exports = XChainEncoder
