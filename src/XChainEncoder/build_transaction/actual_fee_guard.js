/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict'

const { OperationalError } = require('../../build/errors')
const { SATOSHI_UNIT, BURN_BACKSTOP_MULTIPLIER } = require('../constants.js')
const { jsonSafeSat, softDustFloorFor } = require('../script_amount_helpers.js')
const { backstopReferenceFeePerBytes } = require('../fee_policy.js')

// Recheck the fee the finished single transaction will actually pay. Change
// below outputFloor is intentionally omitted, but it must not bypass either
// fee ceiling by becoming an unbounded miner fee.
function refuseExcessiveActualFee(build){
    if (build.p2shHash) return
    const chainOutputFloor = Math.max(this.dustAmount, softDustFloorFor(this.networkKey))
    if (build.changeSatoshis < BigInt(chainOutputFloor) ||
        build.changeSatoshis >= BigInt(this.outputFloor)) return
    const { fee, capFeePerBytes, estimatedTxSize, nodeFeePerBytes, relayFeePerKb } = build
    const outputSatoshis = build.psbt.txOutputs.reduce((sum, output) => sum + BigInt(output.value), 0n)
    const actualFee = build.inputSatoshis - outputSatoshis
    const judgedFee = actualFee - BigInt(build.softDustSurcharge || 0)
    let ceiling = null
    let limit = null

    if (fee != null && fee !== false && capFeePerBytes != null){
        const rateCeiling = BigInt(Math.max(
            this.dustAmount,
            Math.ceil(estimatedTxSize * capFeePerBytes * SATOSHI_UNIT)
        ))
        if (judgedFee > rateCeiling){
            ceiling = rateCeiling
            limit = 'fee-rate cap'
        }
    }

    const referenceFeePerBytes = backstopReferenceFeePerBytes({ nodeFeePerBytes, relayFeePerKb })
    if (referenceFeePerBytes != null){
        const fairFee = Math.ceil(estimatedTxSize * referenceFeePerBytes * SATOSHI_UNIT)
        const burnCeiling = BigInt(Math.max(this.dustAmount, fairFee * BURN_BACKSTOP_MULTIPLIER))
        if (judgedFee > burnCeiling && (ceiling === null || burnCeiling < ceiling)){
            ceiling = burnCeiling
            limit = `${BURN_BACKSTOP_MULTIPLIER}x burn backstop`
        }
    }
    if (ceiling === null) return

    throw new OperationalError(
        'CHANGE_BELOW_OUTPUT_FLOOR',
        `change ${build.changeSatoshis} is below the output floor ${this.outputFloor} and would make ` +
            `the actual fee ${actualFee} exceed the ${limit} ceiling ${ceiling}; add inputs or adjust amounts`,
        { changeSatoshis: jsonSafeSat(build.changeSatoshis), outputFloor: this.outputFloor,
            actualFee: jsonSafeSat(actualFee), ceiling: jsonSafeSat(ceiling) }
    )
}

module.exports = { refuseExcessiveActualFee }
