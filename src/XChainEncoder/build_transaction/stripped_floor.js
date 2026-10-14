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
 * This file holds single-transaction builds to the chain's stripped-size relay floor
 *
 ********************************************************************/

const TxSizeEstimator = require('../../build/tx_size_estimator')
const { OperationalError } = require('../../build/errors')
const coins = require('../../coins')

// The relay floor on a transaction's stripped size that the coin's node software
// enforces, MIN_STANDARD_TX_NONWITNESS_SIZE in src/policy/policy.h: Bitcoin Core 65
// (v25.0 on), Litecoin Core 82. Dogecoin Core has none. These are not the coin
// registry's minStandardTxNonWitnessSize, which pins the reveal pad's target.
const CORE_MIN_STANDARD_TX_NONWITNESS_SIZE = { BTC: 65, LTC: 82 }

// The node floor for this encoder's coin, or 0 where the node has none.
function coreStrippedFloor(networkKey){
    const key = String(networkKey || '')
    const tick = coins.FULL_NAME_TO_TICK[key.slice(0, Math.max(0, key.lastIndexOf('-')))]
    return CORE_MIN_STANDARD_TX_NONWITNESS_SIZE[tick] || 0
}

// Fewest scriptSig bytes an input carries once signed: none for native segwit, the
// redeem-script push for P2SH-P2WPKH, and a P2PKH signature and key for a legacy input.
function scriptSigLowerBound(input){
    if (input.witnessUtxo) return input.redeemScript ? 1 + input.redeemScript.length : 0
    return 106
}

// The stripped size the signed transaction will have, plus changeOutputBytes.
function predictedStrippedSize(build, changeOutputBytes){
    let size = this.strippedTxSize(build.psbt) + changeOutputBytes
    for (const input of build.psbt.data.inputs) size = size + scriptSigLowerBound(input)
    return size
}

// Whether a single-transaction build, as selected so far, clears the node's stripped
// floor. Under it selection keeps going, since one more input or a funded change
// output lifts it over; the reveal pads itself instead.
function clearsStrippedFloor(build, inputSatoshis, selectionFee){
    const floor = coreStrippedFloor(this.networkKey)
    if (!floor || build.p2shHash || !build.change) return true
    const changeSatoshis = inputSatoshis - build.outputSatoshis - BigInt(selectionFee)
    const changeBytes = changeSatoshis >= BigInt(this.outputFloor)
        ? TxSizeEstimator.estimateOutputSizeForAddress(build.change, this.network)
        : 0
    return predictedStrippedSize.call(this, build, changeBytes) >= floor
}

// Refuse a finished single-transaction build that is still under the floor: a node
// will not relay it, and no input was left to fund the change output that lifts it.
function refuseUnderStrippedFloor(build){
    const floor = coreStrippedFloor(this.networkKey)
    if (!floor || build.p2shHash) return
    const strippedSize = predictedStrippedSize.call(this, build, 0)
    if (strippedSize >= floor) return
    throw new OperationalError('TX_BELOW_MIN_STANDARD_SIZE',
        `the transaction would be ${strippedSize} non-witness bytes, under this chain's ${floor}-byte relay ` +
        `minimum, and its inputs leave too little for a change output to lift it: leave at least ` +
        `${this.outputFloor} base units plus its fee for change, or add an input`,
        { strippedSize, minimum: floor })
}

module.exports = { CORE_MIN_STANDARD_TX_NONWITNESS_SIZE, clearsStrippedFloor, refuseUnderStrippedFloor }
